import { Keyboard } from '@maxhub/max-bot-api';
import { tabLabels } from '../constants/requestStatus.js';
import { getFullHouseAddress } from '../lib/houses.js';
import type { RequestFile, RequestRecord } from '../lib/requestsApi.js';

type Tab = 'new' | 'accepted' | 'completed';

const { inlineKeyboard, button } = Keyboard;

export function buildListKeyboard(
  activeTab: Tab,
  requests: RequestRecord[],
  counts: Record<Tab, number>,
) {
  const tabRow = (Object.keys(tabLabels) as Tab[]).map((tab) => {
    const label = `${tab === activeTab ? '• ' : ''}${tabLabels[tab]} (${counts[tab]})`;
    return button.callback(label, `rl:${tab}`);
  });

  const requestRows = requests.map((request) => [
    button.callback(`#${request.id} — ${getFullHouseAddress(request)}`, `ro:${request.id}`),
  ]);

  return inlineKeyboard([tabRow, ...requestRows]);
}

export function buildDetailKeyboard(options: {
  request: RequestRecord;
  tab: Tab;
  nextLabel: string | null;
  showActionButton: boolean;
  hasFiles: boolean;
}) {
  const { request, tab, nextLabel, showActionButton, hasFiles } = options;
  const rows: ReturnType<typeof button.callback>[][] = [];

  if (showActionButton && nextLabel) {
    rows.push([button.callback(nextLabel, `rs:${request.id}`)]);
  }

  rows.push([button.callback('📷 Добавить фото/видео', `rm:${request.id}`)]);
  rows.push([button.callback('📝 Изменить описание работ', `rc:${request.id}`)]);

  if (hasFiles) {
    rows.push([button.callback('🗑 Удалить файл', `rdf:${request.id}`)]);
  }

  rows.push([button.callback('⬅️ К списку', `rl:${tab}`)]);

  return inlineKeyboard(rows);
}

export function buildConfirmKeyboard(requestId: number, sentAPIStatus: string) {
  return inlineKeyboard([
    [
      button.callback('Да', `rsc:${requestId}:${sentAPIStatus}`),
      button.callback('Отмена', `rsx:${requestId}`),
    ],
  ]);
}

export function buildMediaCollectionKeyboard(requestId: number) {
  return inlineKeyboard([[button.callback('✅ Готово', `rmd:${requestId}`)]]);
}

export function buildWorkDoneStepKeyboard(requestId: number) {
  return inlineKeyboard([
    [
      button.callback('Написать', `rc:${requestId}`),
      button.callback('Пропустить', `rws:${requestId}`),
    ],
    [button.callback('⬅️ Отмена', `rb:${requestId}`)],
  ]);
}

export function buildCancelKeyboard(requestId: number) {
  return inlineKeyboard([[button.callback('⬅️ Отмена', `rb:${requestId}`)]]);
}

export function buildDeleteFilesKeyboard(requestId: number, files: RequestFile[]) {
  const rows = files.map((file) => [
    button.callback(`🗑 ${file.name}`, `rdo:${requestId}:${file.id}`),
  ]);
  rows.push([button.callback('⬅️ Назад', `ro:${requestId}`)]);
  return inlineKeyboard(rows);
}
