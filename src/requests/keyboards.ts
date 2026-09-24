import { Keyboard } from '@maxhub/max-bot-api';
import { tabLabels } from '../constants/requestStatus.js';
import { getFullHouseAddress } from '../lib/houses.js';
import { getFileKind, type RequestFile, type RequestRecord } from '../lib/requestsApi.js';

type Tab = 'new' | 'accepted' | 'completed';

const { inlineKeyboard, button } = Keyboard;

const MINIMAL_KEYBOARD_STATUSES = new Set(['Отправлено исполнителю', 'В пути']);

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

  // The accept-request ("Отправлено исполнителю") and en-route ("В пути")
  // cards are single-action screens — keep them to just the action and a
  // way back, without the in-progress editing buttons.
  if (!MINIMAL_KEYBOARD_STATUSES.has(request.status)) {
    rows.push([button.callback('📷 Добавить фото/видео', `rm:${request.id}`)]);
    rows.push([button.callback('📝 Изменить описание работ', `rc:${request.id}`)]);

    if (hasFiles) {
      rows.push([button.callback('📁 Файлы', `rdf:${request.id}`)]);
    }
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

const FILE_KIND_ICON: Record<'image' | 'video' | 'other', string> = {
  image: '📷',
  video: '🎥',
  other: '📄',
};

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

export function buildFileSelectionKeyboard(
  requestId: number,
  files: RequestFile[],
  selectedFileIds: number[],
) {
  const fileButtons = files.map((file, index) => {
    const selected = selectedFileIds.includes(file.id);
    const icon = FILE_KIND_ICON[getFileKind(file)];
    const label = `${selected ? '☑' : '☐'} ${index + 1} ${icon}`;
    return button.callback(label, `rdt:${requestId}:${file.id}`, {
      intent: selected ? 'positive' : 'default',
    });
  });

  const rows = chunk(fileButtons, 3);
  rows.push([
    button.callback(`🗑 Удалить выбранное (${selectedFileIds.length})`, `rda:${requestId}`, {
      intent: 'negative',
    }),
  ]);
  rows.push([button.callback('⬅️ Назад', `rb:${requestId}`)]);
  return inlineKeyboard(rows);
}

export function buildDeleteSelectedConfirmKeyboard(requestId: number) {
  return inlineKeyboard([
    [
      button.callback('Да', `rdy:${requestId}`),
      button.callback('Отмена', `rdb:${requestId}`),
    ],
  ]);
}
