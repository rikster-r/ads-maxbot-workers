import sharp from 'sharp';
import { ackCallback, BotContext, BotState } from '../bot.js';
import { logger } from '../logger.js';
import {
  activeExecutionStatuses,
  completionStatuses,
  formatStatus,
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
import { SessionExpiredError } from '../lib/apiFetch.js';
import { invalidate } from './cache.js';
import { getFullHouseAddress } from '../lib/houses.js';
import { uploadBufferToMax } from '../lib/maxUpload.js';
import {
  buildCancelKeyboard,
  buildConfirmKeyboard,
  buildDeleteSelectedConfirmKeyboard,
  buildDetailKeyboard,
  buildFileSelectionKeyboard,
  buildMediaCollectionKeyboard,
} from './keyboards.js';
import { handleTabAction, requireFieldWorker, type WorkerSession } from './list.js';

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
  const lines: string[] = [`📄 Заявка #${request.id}`, `Статус: ${formatStatus(request.status)}`, ''];

  lines.push(`Адрес: ${getFullHouseAddress(request)}`);
  if (request.entrance) lines.push(`Подъезд: ${request.entrance}, этаж: ${request.floor ?? '—'}`);

  if (request.applicant || request.customer) lines.push('');
  if (request.applicant) {
    lines.push(`Заявитель: ${request.applicant}${request.applicant_phone ? ` (${request.applicant_phone})` : ''}`);
  }
  if (request.customer) {
    lines.push(`Клиент: ${request.customer}${request.customer_phone ? ` (${request.customer_phone})` : ''}`);
  }

  const problem = problemText(request);
  if (problem) lines.push('', `Проблема: ${problem}`);
  if (request.problem_customer) lines.push(`Со слов заявителя: ${request.problem_customer}`);
  if (request.note) lines.push('', `Примечание: ${request.note}`);

  if (request.work_done || request.files.length) lines.push('');
  if (request.work_done) lines.push(`Выполненные работы: ${request.work_done}`);
  if (request.files.length) lines.push(`Файлы: ${request.files.length}`);

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

export async function renderDetail(
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

export async function reRenderDetailAsReply(ctx: BotContext, session: WorkerSession, requestId: number) {
  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.reply('❌ Не удалось загрузить заявку.');
    return;
  }
  const { text, keyboard } = await renderDetail(session, request);
  await ctx.reply(text, { attachments: [keyboard] });
}

async function showCompletionConfirm(ctx: BotContext, request: RequestRecord) {
  const config = statusConfig[request.status];
  const sentAPIStatus = config?.sentAPIStatus;
  if (!sentAPIStatus) return;

  ctx.session = { ...ctx.session, activeRequestId: request.id };

  await ctx.editMessage({
    text: '⚠️ Внимание! Убедитесь что вы внесли информацию о проделанной работе, добавили файлы фото или видео фиксации.',
    attachments: [buildConfirmKeyboard(request.id, sentAPIStatus)],
  });
  await ackCallback(ctx);
}

async function changeStatusAndInvalidate(
  session: WorkerSession,
  requestId: number,
  sentAPIStatus: string,
): Promise<boolean> {
  const ok = await changeRequestStatus(session.token, requestId, sentAPIStatus);
  invalidate(session.adsUserId);
  return ok;
}

async function performStatusChange(
  ctx: BotContext,
  session: WorkerSession,
  requestId: number,
  sentAPIStatus: string,
): Promise<boolean> {
  const ok = await changeStatusAndInvalidate(session, requestId, sentAPIStatus);
  if (!ok) return false;

  const request = await getRequestDetail(session.token, requestId);
  if (request) {
    const { text, keyboard } = await renderDetail(session, request);
    await ctx.editMessage({ text, attachments: [keyboard] });
  }
  return true;
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
    if (request.files.length === 0) {
      await ackCallback(ctx, 'Нужны файлы');
      await ctx.reply('⚠️ Перед завершением заявки добавьте хотя бы одно фото или видео.');
      return;
    }
    await showCompletionConfirm(ctx, request);
    return;
  }

  const ok = await performStatusChange(ctx, session, requestId, config.sentAPIStatus);
  if (!ok) {
    await ctx.answerOnCallback({ notification: 'Не удалось изменить статус' });
    return;
  }
  await ackCallback(ctx);
}

export async function handleStatusConfirm(
  ctx: BotContext,
  requestId: number,
  sentAPIStatus: string,
) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  // Re-check files here too — they may have been deleted while this
  // confirm screen was open.
  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.answerOnCallback({ notification: 'Не удалось загрузить заявку' });
    return;
  }
  if (request.files.length === 0) {
    await ackCallback(ctx, 'Нужны файлы');
    await ctx.reply('⚠️ Перед завершением заявки добавьте хотя бы одно фото или видео.');
    return;
  }

  ctx.session = { ...ctx.session, state: BotState.IDLE };

  const ok = await changeStatusAndInvalidate(session, requestId, sentAPIStatus);
  if (!ok) {
    await ctx.answerOnCallback({ notification: 'Не удалось изменить статус' });
    return;
  }
  // handleTabAction acks the callback itself — don't ack again here.
  await handleTabAction(ctx, 'new');
}

export async function handleStatusCancel(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  ctx.session = { ...ctx.session, state: BotState.IDLE };

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

  ctx.session = { ...ctx.session, state: BotState.IDLE };

  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.answerOnCallback({ notification: 'Не удалось загрузить заявку' });
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

/**
 * Universal "⬅️ Отмена" handler for every in-progress prompt (standalone
 * media/comment entry). Always aborts whatever is in progress and returns
 * to the plain detail view.
 */
export async function handleBackToDetail(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  ctx.session = {
    ...ctx.session,
    state: BotState.IDLE,
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
        if (error instanceof SessionExpiredError) throw error;
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
    if (error instanceof SessionExpiredError) throw error;
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

  ctx.session = { ...ctx.session, state: BotState.IDLE };

  await reRenderDetailAsReply(ctx, session, requestId);
}
