import { Keyboard } from '@maxhub/max-bot-api';
import { bot } from '../bot.js';
import { getWorkerDatabase } from '../db.js';
import { viewerRoles } from '../constants/roles.js';
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
  problem_customer: string | null;
  maintenance_from: string | null;
  maintenance_to: string | null;
  applicant: string | null;
  applicant_phone: string | null;
  address: string | null;
  files: ApplicationCreatedFile[];
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
  if (app.organization) lines.push(`Организация: ${app.organization}`);

  if (app.note) lines.push('', `Примечание: ${app.note}`);
  if (app.problem_customer) lines.push(`Со слов заявителя: ${app.problem_customer}`);

  if (app.maintenance_from || app.maintenance_to) {
    lines.push('', `Время приёма: ${app.maintenance_from ?? '—'}–${app.maintenance_to ?? '—'}`);
  }

  if (app.files.length > 0) lines.push('', `📎 Файлов: ${app.files.length}`);

  return lines.join('\n');
}

export async function notifyDispatchersOfNewApplication(
  payload: ApplicationCreatedPayload,
): Promise<void> {
  const app = payload.application;
  const dispatchers = getWorkerDatabase().getActiveSessionsByRoles(viewerRoles);
  if (dispatchers.length === 0) return;

  const text = formatApplicationCreatedText(app);
  const keyboard = buildAcceptApplicationKeyboard(app.id);

  const results = await Promise.allSettled(
    dispatchers.map((session) =>
      bot.api.sendMessageToUser(session.max_user_id, text, { attachments: [keyboard] }),
    ),
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason }, 'Error sending new-application notification');
    }
  }
}
