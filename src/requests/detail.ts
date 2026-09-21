import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ackCallback, bot, BotContext, BotState } from '../bot.js';
import { logger } from '../logger.js';
import {
  activeExecutionStatuses,
  completionStatuses,
  inWorkStatuses,
  statusConfig,
} from '../constants/requestStatus.js';
import {
  addComment,
  changeRequestStatus,
  deleteRequestFile,
  downloadRequestFile,
  getFileKind,
  getRequestDetail,
  getUserRequests,
  uploadRequestMedia,
  type RequestFile,
  type RequestRecord,
} from '../lib/requestsApi.js';
import { invalidate } from './cache.js';
import { getFullHouseAddress } from '../lib/houses.js';
import {
  buildCancelKeyboard,
  buildConfirmKeyboard,
  buildDeleteSelectedConfirmKeyboard,
  buildDetailKeyboard,
  buildFileSelectionKeyboard,
  buildMediaCollectionKeyboard,
  buildWorkDoneStepKeyboard,
} from './keyboards.js';
import { requireFieldWorker, type WorkerSession } from './list.js';

type Tab = 'new' | 'accepted' | 'completed';

function tabForStatus(status: string): Tab {
  if (status === 'Отправлено исполнителю') return 'new';
  if (status === 'Выполнена') return 'completed';
  return 'accepted';
}

function problemText(request: RequestRecord): string | null {
  if (!request.problem) return null;
  return typeof request.problem === 'string' ? request.problem : request.problem.name;
}

function formatDetailText(request: RequestRecord, blockingRequest: RequestRecord | null): string {
  const lines: string[] = [`📄 Заявка #${request.id}`, `Статус: ${request.status}`, ''];

  if (request.applicant) {
    lines.push(`Заявитель: ${request.applicant}${request.applicant_phone ? ` (${request.applicant_phone})` : ''}`);
  }
  if (request.customer) {
    lines.push(`Клиент: ${request.customer}${request.customer_phone ? ` (${request.customer_phone})` : ''}`);
  }

  lines.push('', `Адрес: ${getFullHouseAddress(request)}`);
  if (request.entrance) lines.push(`Подъезд: ${request.entrance}, этаж: ${request.floor ?? '—'}`);

  if (typeof request.organization === 'string' && request.organization) {
    lines.push(`Организация: ${request.organization}`);
  }

  const problem = problemText(request);
  if (problem) lines.push('', `Проблема: ${problem}`);
  if (request.problem_customer) lines.push(`Со слов заявителя: ${request.problem_customer}`);
  if (request.note) lines.push('', `Примечание: ${request.note}`);

  lines.push('', `Выполненные работы: ${request.work_done || '—'}`);
  lines.push(`Файлы: ${request.files.length}`);

  if (blockingRequest) {
    lines.push(
      '',
      `⚠️ У вас уже есть заявка №${blockingRequest.id} на исполнении (${getFullHouseAddress(blockingRequest)}). Завершите её, прежде чем менять статус этой заявки.`,
    );
  }

  return lines.join('\n');
}

async function findBlockingActiveRequest(
  session: WorkerSession,
  request: RequestRecord,
): Promise<RequestRecord | null> {
  // Only relevant while the request is still actionable — a finished/cancelled/
  // closed request, or one not yet accepted, can't be blocked by anything.
  if (!inWorkStatuses.includes(request.status) || request.status === 'Отправлено исполнителю') {
    return null;
  }

  const allRequests = await getUserRequests(session.token, session.adsUserId);
  if (!allRequests) return null;

  return (
    allRequests.find((r) => r.id !== request.id && activeExecutionStatuses.includes(r.status)) ??
    null
  );
}

async function renderDetail(
  session: WorkerSession,
  request: RequestRecord,
): Promise<{ text: string; keyboard: ReturnType<typeof buildDetailKeyboard> }> {
  const blockingRequest = await findBlockingActiveRequest(session, request);
  const config = statusConfig[request.status];
  const showActionButton = inWorkStatuses.includes(request.status) && !blockingRequest;

  return {
    text: formatDetailText(request, blockingRequest),
    keyboard: buildDetailKeyboard({
      request,
      tab: tabForStatus(request.status),
      nextLabel: config?.nextLabel ?? null,
      showActionButton,
      hasFiles: request.files.length > 0,
    }),
  };
}

export async function handleOpenRequest(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.answerOnCallback({ notification: 'Не удалось загрузить заявку' });
    return;
  }

  ctx.session = { ...ctx.session, activeRequestId: requestId };

  const { text, keyboard } = await renderDetail(session, request);
  await ctx.editMessage({ text, attachments: [keyboard] });
  await ackCallback(ctx);
}

async function reRenderDetailAsReply(ctx: BotContext, session: WorkerSession, requestId: number) {
  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.reply('❌ Не удалось загрузить заявку.');
    return;
  }
  const { text, keyboard } = await renderDetail(session, request);
  await ctx.reply(text, { attachments: [keyboard] });
}

async function startCompletionFlow(ctx: BotContext, session: WorkerSession, request: RequestRecord) {
  ctx.session = {
    ...ctx.session,
    activeRequestId: request.id,
    completionFlow: true,
  };

  if (request.files.length === 0) {
    ctx.session = { ...ctx.session, state: BotState.WAITING_MEDIA };
    await ctx.editMessage({
      text: '📷 Прикрепите фото или видео, чтобы завершить заявку. Это обязательно.',
      attachments: [buildCancelKeyboard(request.id)],
    });
    await ackCallback(ctx);
    return;
  }

  await promptWorkDoneOrConfirm(ctx, request);
}

async function promptWorkDoneOrConfirm(ctx: BotContext, request: RequestRecord) {
  if (!request.work_done) {
    ctx.session = { ...ctx.session, state: BotState.IDLE };
    await ctx.editMessage({
      text: '📝 Хотите добавить описание выполненных работ?',
      attachments: [buildWorkDoneStepKeyboard(request.id)],
    });
    await ackCallback(ctx);
    return;
  }

  await promptFinalConfirm(ctx, request);
}

async function promptFinalConfirm(ctx: BotContext, request: RequestRecord) {
  const config = statusConfig[request.status];
  const sentAPIStatus = config?.sentAPIStatus;
  if (!sentAPIStatus) return;

  await ctx.editMessage({
    text: 'Завершить заявку?',
    attachments: [buildConfirmKeyboard(request.id, sentAPIStatus)],
  });
  await ackCallback(ctx);
}

export async function handleStatusAction(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.answerOnCallback({ notification: 'Не удалось загрузить заявку' });
    return;
  }

  const blockingRequest = await findBlockingActiveRequest(session, request);
  if (blockingRequest) {
    await ctx.answerOnCallback({
      notification: `У вас уже есть заявка №${blockingRequest.id} на исполнении. Завершите её, прежде чем менять статус другой заявки.`,
    });
    return;
  }

  const config = statusConfig[request.status];
  if (!config?.sentAPIStatus) {
    await ackCallback(ctx);
    return;
  }

  if (completionStatuses.includes(request.status)) {
    await startCompletionFlow(ctx, session, request);
    return;
  }

  await ctx.editMessage({
    text: `Вы уверены? Статус изменится на «${config.nextStatus}».`,
    attachments: [buildConfirmKeyboard(requestId, config.sentAPIStatus)],
  });
  await ackCallback(ctx);
}

export async function handleStatusConfirm(
  ctx: BotContext,
  requestId: number,
  sentAPIStatus: string,
) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const ok = await changeRequestStatus(session.token, requestId, sentAPIStatus);
  invalidate(session.adsUserId);
  ctx.session = { ...ctx.session, completionFlow: false, state: BotState.IDLE };

  if (!ok) {
    await ctx.answerOnCallback({ notification: 'Не удалось изменить статус' });
    return;
  }

  const request = await getRequestDetail(session.token, requestId);
  if (request) {
    const { text, keyboard } = await renderDetail(session, request);
    await ctx.editMessage({ text, attachments: [keyboard] });
  }
  await ctx.answerOnCallback({ notification: 'Статус изменён' });
}

export async function handleStatusCancel(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  ctx.session = { ...ctx.session, completionFlow: false, state: BotState.IDLE };

  const request = await getRequestDetail(session.token, requestId);
  if (request) {
    const { text, keyboard } = await renderDetail(session, request);
    await ctx.editMessage({ text, attachments: [keyboard] });
  }
  await ackCallback(ctx);
}

export async function handleAddMediaButton(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  ctx.session = {
    ...ctx.session,
    activeRequestId: requestId,
    completionFlow: false,
    state: BotState.WAITING_MEDIA,
  };

  await ackCallback(ctx);
  await ctx.reply('📷 Отправьте фото или видео. Когда закончите, нажмите «Готово».', {
    attachments: [buildCancelKeyboard(requestId)],
  });
}

export async function handleMediaDone(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const wasCompletionFlow = ctx.session.completionFlow === true;
  ctx.session = { ...ctx.session, state: BotState.IDLE };

  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.answerOnCallback({ notification: 'Не удалось загрузить заявку' });
    return;
  }

  if (wasCompletionFlow) {
    await promptWorkDoneOrConfirm(ctx, request);
    return;
  }

  const { text, keyboard } = await renderDetail(session, request);
  await ctx.editMessage({ text, attachments: [keyboard] });
  await ackCallback(ctx);
}

export async function handleCommentButton(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  ctx.session = {
    ...ctx.session,
    activeRequestId: requestId,
    state: BotState.WAITING_COMMENT,
  };

  await ackCallback(ctx);
  await ctx.reply('📝 Введите описание выполненных работ:', {
    attachments: [buildCancelKeyboard(requestId)],
  });
}

export async function handleWorkDoneSkip(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.answerOnCallback({ notification: 'Не удалось загрузить заявку' });
    return;
  }

  await promptFinalConfirm(ctx, request);
}

/**
 * Universal "⬅️ Отмена" handler for every in-progress prompt (standalone
 * media/comment entry, the completion wizard's photo/work-done steps).
 * Always aborts whatever is in progress and returns to the plain detail view.
 */
export async function handleBackToDetail(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  ctx.session = {
    ...ctx.session,
    state: BotState.IDLE,
    completionFlow: false,
    selectedFileIds: [],
  };

  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.answerOnCallback({ notification: 'Не удалось загрузить заявку' });
    return;
  }

  const { text, keyboard } = await renderDetail(session, request);
  await ctx.editMessage({ text, attachments: [keyboard] });
  await ackCallback(ctx);
}

const FILE_KIND_LABEL: Record<'image' | 'video' | 'other', { icon: string; label: string }> = {
  image: { icon: '📷', label: 'Фото' },
  video: { icon: '🎥', label: 'Видео' },
  other: { icon: '📄', label: 'Файл' },
};

function buildFileListCaption(requestId: number, files: RequestFile[]): string {
  const lines = files.map((file, index) => {
    const { icon, label } = FILE_KIND_LABEL[getFileKind(file)];
    return `${index + 1}. ${icon} ${label}`;
  });
  return [`📁 Файлы заявки #${requestId}:`, ...lines].join('\n');
}

// The SDK's upload helper picks a different code path per source type, and
// each media kind is only reliable on one of them (opposite of each other):
//  - image: a file-path source falls back to a hand-rolled multipart body
//    that isn't a real Blob, so MAX silently receives no file at all — a
//    raw Buffer instead goes through the SDK's Blob-based multipart path,
//    which works.
//  - video: a raw Buffer forces a single-shot multipart upload whose
//    response MAX's video CDN answers with a legacy `<retval>1</retval>`
//    plaintext body — but the SDK always does res.json() on it, so it
//    throws. A file-path source instead routes through the chunked
//    (Content-Range) path, which reads the response as plain text.
async function uploadBufferToMax(kind: 'image' | 'video', data: Buffer) {
  if (kind === 'image') {
    return bot.api.uploadImage({ source: data });
  }

  const tempPath = path.join(os.tmpdir(), `max-video-${randomUUID()}.mp4`);
  await writeFile(tempPath, data);
  try {
    return await bot.api.uploadVideo({ source: tempPath });
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function buildFilePreviewAttachments(token: string, files: RequestFile[]) {
  const attachments = await Promise.all(
    files.map(async (file) => {
      const kind = getFileKind(file);
      if (kind !== 'image' && kind !== 'video') return null;

      try {
        // file.url is this app's own protected endpoint, not MAX's CDN —
        // MAX can't fetch it on its own, so the bytes have to come through us.
        const data = await downloadRequestFile(token, file.url);
        const attachment = await uploadBufferToMax(kind, data);
        return attachment.toJson();
      } catch (error) {
        logger.error({ err: error, fileId: file.id }, 'Failed to build file preview attachment');
        return null;
      }
    }),
  );
  return attachments.filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);
}

export async function handleDeleteFilesEntry(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const request = await getRequestDetail(session.token, requestId);
  if (!request || request.files.length === 0) {
    await ctx.answerOnCallback({ notification: 'Нет файлов для отображения' });
    return;
  }

  ctx.session = { ...ctx.session, activeRequestId: requestId, selectedFileIds: [] };
  await ackCallback(ctx);

  const mediaAttachments = await buildFilePreviewAttachments(session.token, request.files);
  await ctx.reply(buildFileListCaption(requestId, request.files), {
    attachments: mediaAttachments,
  });

  await ctx.reply('Нажмите на файл, чтобы выбрать его для удаления:', {
    attachments: [buildFileSelectionKeyboard(requestId, request.files, [])],
  });
}

export async function handleFileToggle(ctx: BotContext, requestId: number, fileId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.answerOnCallback({ notification: 'Не удалось загрузить заявку' });
    return;
  }

  const current = ctx.session.selectedFileIds ?? [];
  const selectedFileIds = current.includes(fileId)
    ? current.filter((id) => id !== fileId)
    : [...current, fileId];
  ctx.session = { ...ctx.session, selectedFileIds };

  await ctx.editMessage({
    text: 'Нажмите на файл, чтобы выбрать его для удаления:',
    attachments: [buildFileSelectionKeyboard(requestId, request.files, selectedFileIds)],
  });
  await ackCallback(ctx);
}

export async function handleDeleteSelectedAsk(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const selectedFileIds = ctx.session.selectedFileIds ?? [];
  if (selectedFileIds.length === 0) {
    await ctx.answerOnCallback({ notification: 'Ничего не выбрано' });
    return;
  }

  await ctx.editMessage({
    text: `Удалить ${selectedFileIds.length} файл(ов)? Это действие необратимо.`,
    attachments: [buildDeleteSelectedConfirmKeyboard(requestId)],
  });
  await ackCallback(ctx);
}

export async function handleDeleteSelectedBack(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.answerOnCallback({ notification: 'Не удалось загрузить заявку' });
    return;
  }

  const selectedFileIds = ctx.session.selectedFileIds ?? [];
  await ctx.editMessage({
    text: 'Нажмите на файл, чтобы выбрать его для удаления:',
    attachments: [buildFileSelectionKeyboard(requestId, request.files, selectedFileIds)],
  });
  await ackCallback(ctx);
}

export async function handleDeleteSelectedConfirm(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const selectedFileIds = ctx.session.selectedFileIds ?? [];
  const results = await Promise.allSettled(
    selectedFileIds.map((fileId) => deleteRequestFile(session.token, fileId)),
  );
  const succeeded = results.filter((result) => result.status === 'fulfilled' && result.value).length;
  const failed = selectedFileIds.length - succeeded;

  invalidate(session.adsUserId);
  ctx.session = { ...ctx.session, selectedFileIds: [] };

  const request = await getRequestDetail(session.token, requestId);
  if (request) {
    const { text, keyboard } = await renderDetail(session, request);
    await ctx.editMessage({ text, attachments: [keyboard] });
  }

  const notification =
    failed > 0
      ? `Удалено файлов: ${succeeded}. Не удалось удалить: ${failed}.`
      : `Удалено файлов: ${succeeded}`;
  await ctx.answerOnCallback({ notification });
}

async function downloadAttachment(url: string): Promise<{ data: Buffer; contentType: string | null }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment: ${response.status} ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    data: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type'),
  };
}

// Extensions accepted by the remote API's `mimes:` validation rule.
const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
};
const VIDEO_MIME_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/avi': 'avi',
  'video/x-msvideo': 'avi',
};

interface IncomingMediaAttachment {
  type: 'image' | 'video';
  payload: { url: string };
}

export async function handleIncomingMedia(ctx: BotContext) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const requestId = ctx.session.activeRequestId;
  if (!requestId) return;

  const attachments = ctx.message?.body?.attachments ?? [];
  const mediaAttachments = (attachments as unknown as IncomingMediaAttachment[]).filter(
    (a) => a.type === 'image' || a.type === 'video',
  );

  if (mediaAttachments.length === 0) {
    await ctx.reply('Отправьте фото или видео сообщением.');
    return;
  }

  try {
    const files = await Promise.all(
      mediaAttachments.map(async (attachment, index) => {
        let { data, contentType } = await downloadAttachment(attachment.payload.url);

        let mimeType: string;
        let ext: string;

        if (attachment.type === 'image') {
          if (!contentType || !IMAGE_MIME_TO_EXT[contentType]) {
            // MAX's CDN re-encodes photos as WebP, which the remote API
            // doesn't accept — transcode to JPEG so the upload matches its
            // `mimes:` rule.
            data = await sharp(data).jpeg().toBuffer();
            contentType = 'image/jpeg';
          }
          mimeType = contentType;
          ext = IMAGE_MIME_TO_EXT[mimeType];
        } else {
          mimeType = 'video/mp4';
          if (contentType && VIDEO_MIME_TO_EXT[contentType]) {
            mimeType = contentType;
          }
          ext = VIDEO_MIME_TO_EXT[mimeType];
        }

        return {
          data,
          filename: `${attachment.type}-${Date.now()}-${index}.${ext}`,
          mimeType,
        };
      }),
    );

    const ok = await uploadRequestMedia(session.token, requestId, files);
    if (!ok) {
      await ctx.reply('❌ Не удалось загрузить файлы. Попробуйте ещё раз.');
      return;
    }

    invalidate(session.adsUserId);
    await ctx.reply('✅ Файлы добавлены. Отправьте ещё или нажмите «Готово».', {
      attachments: [buildMediaCollectionKeyboard(requestId)],
    });
  } catch (error) {
    logger.error({ err: error }, 'Error handling incoming media');
    await ctx.reply('❌ Не удалось загрузить файлы. Попробуйте ещё раз.');
  }
}

export async function handleIncomingComment(ctx: BotContext, text: string) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const requestId = ctx.session.activeRequestId;
  if (!requestId) return;

  const trimmed = text.trim();
  if (!trimmed) {
    await ctx.reply('Описание не может быть пустым. Введите текст:');
    return;
  }

  const ok = await addComment(session.token, requestId, trimmed);
  if (!ok) {
    await ctx.reply('❌ Не удалось сохранить описание. Попробуйте ещё раз.');
    return;
  }
  invalidate(session.adsUserId);

  const wasCompletionFlow = ctx.session.completionFlow === true;
  ctx.session = { ...ctx.session, state: BotState.IDLE };

  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.reply('❌ Не удалось загрузить заявку.');
    return;
  }

  if (wasCompletionFlow) {
    const config = statusConfig[request.status];
    const sentAPIStatus = config?.sentAPIStatus;
    if (sentAPIStatus) {
      await ctx.reply('Завершить заявку?', {
        attachments: [buildConfirmKeyboard(requestId, sentAPIStatus)],
      });
    }
    return;
  }

  await reRenderDetailAsReply(ctx, session, requestId);
}
