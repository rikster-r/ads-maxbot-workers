import { Keyboard } from '@maxhub/max-bot-api';
import { bot } from '../bot.js';
import { getWorkerDatabase } from '../db.js';
import { logger } from '../logger.js';
import { formatPriority } from '../constants/requestPriority.js';
import { getFullHouseAddress } from '../lib/houses.js';
import { getRequestDetail, type RequestRecord } from '../lib/requestsApi.js';

const { inlineKeyboard, button } = Keyboard;

export interface UserNotificationPayload {
  id: string;
  data: { message?: string };
}

const ASSIGNED_REQUEST_ID = /№\s*(\d+)/;

export function buildAcceptApplicationKeyboard(requestId: number) {
  return inlineKeyboard([[button.callback('✅ Принять', `ac:${requestId}`)]]);
}

export function formatApplicationAssignedText(message: string, request: RequestRecord): string {
  const lines: string[] = [message, `Приоритет: ${formatPriority(request.priority)}`, ''];

  if (request.house) lines.push(`Адрес: ${getFullHouseAddress(request)}`);
  if (request.entrance) lines.push(`Подъезд: ${request.entrance}, этаж: ${request.floor ?? '—'}`);

  if (request.customer) {
    lines.push(`Клиент: ${request.customer}${request.customer_phone ? ` (${request.customer_phone})` : ''}`);
  }

  if (request.note) lines.push('', `Примечание: ${request.note}`);
  if (request.problem) {
    const problem = typeof request.problem === 'string' ? request.problem : request.problem.name;
    lines.push(`Проблема: ${problem}`);
  }

  return lines.join('\n');
}

/**
 * Handles a `notifications` event from a worker's private channel: the
 * payload only carries the message text, so the request number is parsed
 * out of it and the details are fetched with that worker's own token.
 */
export async function notifyWorkerOfAssignedApplication(
  adsUserId: number,
  payload: UserNotificationPayload,
): Promise<void> {
  const message = payload.data?.message;
  const match = message?.match(ASSIGNED_REQUEST_ID);
  if (!message || !match) return;

  const workers = getWorkerDatabase().getActiveSessionsByAdsUserIds([adsUserId]);
  if (workers.length === 0) return;

  const requestId = Number(match[1]);
  const request = await getRequestDetail(workers[0].token, requestId);
  if (!request) {
    logger.error({ requestId, adsUserId }, 'Could not load assigned request for notification');
    return;
  }

  const text = formatApplicationAssignedText(message, request);
  const keyboard = buildAcceptApplicationKeyboard(requestId);

  const results = await Promise.allSettled(
    workers.map((session) =>
      bot.api.sendMessageToUser(session.max_user_id, text, { attachments: [keyboard] }),
    ),
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason }, 'Error sending assigned-application notification');
    }
  }
}
