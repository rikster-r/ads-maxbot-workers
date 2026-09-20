import { ackCallback, BotContext, BotState } from '../bot.js';
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
  getRequestDetail,
  getUserRequests,
  uploadRequestMedia,
  type RequestRecord,
} from '../lib/requestsApi.js';
import { invalidate } from './cache.js';
import { getFullHouseAddress } from '../lib/houses.js';
import {
  buildCancelKeyboard,
  buildConfirmKeyboard,
  buildDeleteFilesKeyboard,
  buildDetailKeyboard,
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

  ctx.session = { ...ctx.session, state: BotState.IDLE, completionFlow: false };

  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.answerOnCallback({ notification: 'Не удалось загрузить заявку' });
    return;
  }

  const { text, keyboard } = await renderDetail(session, request);
  await ctx.editMessage({ text, attachments: [keyboard] });
  await ackCallback(ctx);
}

export async function handleDeleteFilesEntry(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const request = await getRequestDetail(session.token, requestId);
  if (!request || request.files.length === 0) {
    await ctx.answerOnCallback({ notification: 'Нет файлов для удаления' });
    return;
  }

  await ctx.editMessage({
    text: 'Выберите файл для удаления:',
    attachments: [buildDeleteFilesKeyboard(requestId, request.files)],
  });
  await ackCallback(ctx);
}

export async function handleDeleteFileConfirm(
  ctx: BotContext,
  requestId: number,
  fileId: number,
) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const ok = await deleteRequestFile(session.token, fileId);
  invalidate(session.adsUserId);

  if (!ok) {
    await ctx.answerOnCallback({ notification: 'Не удалось удалить файл' });
    return;
  }

  const request = await getRequestDetail(session.token, requestId);
  if (request) {
    const { text, keyboard } = await renderDetail(session, request);
    await ctx.editMessage({ text, attachments: [keyboard] });
  }
  await ctx.answerOnCallback({ notification: 'Файл удалён' });
}

async function downloadAttachment(url: string): Promise<Buffer> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

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
        const isImage = attachment.type === 'image';
        const data = await downloadAttachment(attachment.payload.url);
        return {
          data,
          filename: `${attachment.type}-${Date.now()}-${index}.${isImage ? 'jpg' : 'mp4'}`,
          mimeType: isImage ? 'image/jpeg' : 'video/mp4',
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
