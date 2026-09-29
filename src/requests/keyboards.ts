import { Keyboard } from '@maxhub/max-bot-api';
import { tabLabels } from '../constants/requestStatus.js';
import { getFullHouseAddress } from '../lib/houses.js';
import { getFileKind, type RequestFile, type RequestRecord } from '../lib/requestsApi.js';

type Tab = 'new' | 'accepted' | 'completed';

const { inlineKeyboard, button } = Keyboard;

const COMPLETION_KEYBOARD_STATUSES = new Set(['Прибыл', 'На исполнении']);

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

  // The "arrived" ("Прибыл") and "on site" ("На исполнении") cards lead up
  // to completing the request — fixed order.
  if (COMPLETION_KEYBOARD_STATUSES.has(request.status)) {
    const rows: ReturnType<typeof button.callback>[][] = [
      [button.callback('🏠 Карточка дома', `rh:${request.id}`)],
      [button.callback('📝 Выполненная работа', `rc:${request.id}`)],
      [button.callback('📷 Добавить фото и видео', `rm:${request.id}`)],
    ];
    if (hasFiles) {
      rows.push([button.callback('📁 Файлы', `rdf:${request.id}`)]);
    }
    if (showActionButton && nextLabel) {
      rows.push([button.callback(`✅ ${nextLabel}`, `rs:${request.id}`)]);
    }
    rows.push([button.callback('⬅️ К списку заявок', `rl:${tab}`)]);
    return inlineKeyboard(rows);
  }

  const rows: ReturnType<typeof button.callback>[][] = [];

  if (showActionButton && nextLabel) {
    rows.push([button.callback(nextLabel, `rs:${request.id}`)]);
  }

  // Work description, media and files are only handled on the completion
  // cards above; every other stage gets the action, the house card and a way back.
  rows.push([button.callback('🏠 Карточка дома', `rh:${request.id}`)]);
  rows.push([button.callback('⬅️ К списку', `rl:${tab}`)]);

  return inlineKeyboard(rows);
}

export function buildConfirmKeyboard(requestId: number, sentAPIStatus: string) {
  return inlineKeyboard([
    [
      button.callback('Выполнена', `rsc:${requestId}:${sentAPIStatus}`),
      button.callback('Внести изменения', `rsx:${requestId}`),
    ],
  ]);
}

export function buildMediaCollectionKeyboard(requestId: number) {
  return inlineKeyboard([[button.callback('✅ Готово', `rmd:${requestId}`)]]);
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

export type HouseTab = 'i' | 'e' | 'f';

const HOUSE_TAB_LABELS: Record<HouseTab, string> = {
  i: 'Инфо',
  e: 'Прочее',
  f: 'Файлы',
};

export function buildHouseCardKeyboard(houseId: number, requestId: number, activeTab: HouseTab) {
  const tabRow = (Object.keys(HOUSE_TAB_LABELS) as HouseTab[]).map((tab) => {
    const label = `${tab === activeTab ? '• ' : ''}${HOUSE_TAB_LABELS[tab]}`;
    return button.callback(label, `rht:${houseId}:${requestId}:${tab}`);
  });

  return inlineKeyboard([
    tabRow,
    [button.callback('⬅️ Назад к заявке', `rhb:${requestId}`)],
  ]);
}
