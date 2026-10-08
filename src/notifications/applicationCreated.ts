import { Keyboard } from '@maxhub/max-bot-api';
import { bot } from '../bot.js';
import { getWorkerDatabase } from '../db.js';
import { logger } from '../logger.js';

const { inlineKeyboard, button } = Keyboard;

export interface ApplicationCreatedFile {
  id: number;
  url: string;
  name: string;
}

export interface ApplicationCreatedRecord {
  id: number;
  created_at: string;
  customer: string | null;
  phone: string | null;
  organization: string | null;
  entrance: string | null;
  floor: string | null;
  apartment: string | null;
  intercom_code: string | null;
  note: string | null;
  problem: string | { id: number; name: string } | null;
  problem_customer: string | null;
  applicant: string | null;
  applicant_phone: string | null;
  address: string | null;
  files: ApplicationCreatedFile[];
  users: number[];
}

export interface ApplicationCreatedPayload {
  application: ApplicationCreatedRecord;
}

export function buildAcceptApplicationKeyboard(requestId: number) {
  return inlineKeyboard([[button.callback('✅ Принять', `ac:${requestId}`)]]);
}

export function formatApplicationCreatedText(app: ApplicationCreatedRecord): string {
  const lines: string[] = [`🆕 Новая заявка #${app.id}`, ''];

  if (app.address) lines.push(`Адрес: ${app.address}`);
  if (app.entrance) lines.push(`Подъезд: ${app.entrance}, этаж: ${app.floor ?? '—'}`);

  if (app.customer) {
    lines.push(`Клиент: ${app.customer}${app.phone ? ` (${app.phone})` : ''}`);
  }
  if (app.applicant) {
    lines.push(
      `Заявитель: ${app.applicant}${app.applicant_phone ? ` (${app.applicant_phone})` : ''}`,
    );
  }

  if (app.note) lines.push('', `Примечание: ${app.note}`);
  if (app.problem) {
    const problem = typeof app.problem === 'string' ? app.problem : app.problem.name;
    lines.push(`Проблема: ${problem}`);
  }
  if (app.problem_customer) lines.push(`Со слов заявителя: ${app.problem_customer}`);

  if (app.files.length > 0) lines.push('', `📎 Файлов: ${app.files.length}`);

  return lines.join('\n');
}

export async function notifyAssignedWorkersOfNewApplication(
  payload: ApplicationCreatedPayload,
): Promise<void> {
  const app = payload.application;
  const workers = getWorkerDatabase().getActiveSessionsByAdsUserIds(app.users);
  if (workers.length === 0) return;

  const text = formatApplicationCreatedText(app);
  const keyboard = buildAcceptApplicationKeyboard(app.id);

  const results = await Promise.allSettled(
    workers.map((session) =>
      bot.api.sendMessageToUser(session.max_user_id, text, { attachments: [keyboard] }),
    ),
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason }, 'Error sending new-application notification');
    }
  }
}
