import { ackCallback, BotContext } from '../bot.js';
import { logger } from '../logger.js';
import {
  downloadHouseFile,
  getHouseDetail,
  getHouseFileKind,
  type HouseDetail,
  type HouseFile,
  type HouseSummary,
} from '../lib/housesApi.js';
import { getRequestDetail, type RequestRecord } from '../lib/requestsApi.js';
import { getShortHouseAddress } from '../lib/houses.js';
import { uploadBufferToMax } from '../lib/maxUpload.js';
import { renderDetail, reRenderDetailAsReply } from './detail.js';
import { buildHouseCardKeyboard, type HouseTab } from './keyboards.js';
import { requireFieldWorker } from './list.js';

function extractHouseSummary(request: RequestRecord): HouseSummary | null {
  return typeof request.house === 'object' && request.house !== null ? request.house : null;
}

function houseCardHeader(house: HouseSummary): string {
  return `🏠 ${getShortHouseAddress(house)}`;
}

// HouseDetail (GET /houses/{id}) has no full_address field — compose a
// short address from its street/number instead, matching the style
// getShortHouseAddress produces for HouseSummary.
function houseDetailCardHeader(house: HouseDetail): string {
  const short = [house.street, house.number].filter(Boolean).join(' ');
  return `🏠 ${short || 'Адрес не указан'}`;
}

// "only push non-empty lines" — mirrors formatDetailText's style. Numeric
// count fields use `!= null` (not truthiness) so a legitimate 0 isn't
// hidden; string fields use plain truthiness.
function formatHouseInfoText(house: HouseSummary, organization: string | null): string {
  const lines: string[] = [houseCardHeader(house), ''];

  if (house.complex) lines.push(`Название ЖК: ${house.complex}`);
  if (house.full_address) lines.push(`Адрес: ${house.full_address}`);
  if (organization) lines.push(`Организация: ${organization}`);
  if (house.count_entrance != null) lines.push(`Количество подъездов: ${house.count_entrance}`);
  if (house.count_floor != null) lines.push(`Количество этажей: ${house.count_floor}`);
  if (house.count_apartment != null) lines.push(`Количество квартир: ${house.count_apartment}`);
  if (house.address_type?.name) lines.push(`Тип адреса: ${house.address_type.name}`);
  if (house.intercom_code) lines.push(`Код домофона: ${house.intercom_code}`);
  if (house.key_location) lines.push(`Местонахождение ключей: ${house.key_location}`);
  if (house.note) lines.push(`Примечание: ${house.note}`);

  return lines.join('\n');
}

function formatHouseExtraText(house: HouseDetail): string {
  const lines: string[] = [houseDetailCardHeader(house), '', '🔧 Прочее', ''];

  lines.push(`Шлагбаум: ${house.barrier ? 'Есть' : 'Нет'}`);
  lines.push(`Подвал: ${house.basement ? 'Есть' : 'Нет'}`);
  lines.push(`Техэтаж: ${house.technical_floor ? 'Есть' : 'Нет'}`);

  const equipmentRows: [string, string | null][] = [
    ['ВРУ', house.vru],
    ['ГВС', house.dhw],
    ['ХВС', house.cws],
    ['Теплоузел', house.heating_unit],
    ['Насосная', house.pump],
  ];
  for (const [label, value] of equipmentRows) {
    if (value) lines.push(`${label}: ${value}`);
  }

  return lines.join('\n');
}

const HOUSE_FILE_KIND_LABEL: Record<'image' | 'video' | 'other', { icon: string; label: string }> = {
  image: { icon: '📷', label: 'Фото' },
  video: { icon: '🎥', label: 'Видео' },
  other: { icon: '📄', label: 'Файл' },
};

function formatHouseFilesText(house: HouseDetail): string {
  const lines: string[] = [houseDetailCardHeader(house), '', '📁 Файлы'];

  if (house.files.length === 0) {
    lines.push('', 'Файлов нет.');
    return lines.join('\n');
  }

  lines.push('');
  house.files.forEach((file, index) => {
    const { icon, label } = HOUSE_FILE_KIND_LABEL[getHouseFileKind(file)];
    lines.push(`${index + 1}. ${icon} ${label}`);
  });

  return lines.join('\n');
}

async function buildHouseFilePreviewAttachments(token: string, files: HouseFile[]) {
  const attachments = await Promise.all(
    files.map(async (file) => {
      const kind = getHouseFileKind(file);
      if (kind !== 'image' && kind !== 'video') return null;

      try {
        const data = await downloadHouseFile(token, file.file);
        const attachment = await uploadBufferToMax(kind, data);
        return attachment.toJson();
      } catch (error) {
        logger.error({ err: error, fileId: file.id }, 'Failed to build house file preview attachment');
        return null;
      }
    }),
  );
  return attachments.filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);
}

export async function handleHouseCardOpen(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const request = await getRequestDetail(session.token, requestId);
  if (!request) {
    await ctx.answerOnCallback({ notification: 'Не удалось загрузить заявку' });
    return;
  }

  const houseSummary = extractHouseSummary(request);
  if (!houseSummary) {
    await ctx.answerOnCallback({ notification: 'Дом не найден' });
    return;
  }

  // Only one keyboard should be active at a time — strip the request
  // card's keyboard (keeping its text) before the house card takes over.
  // attachments: [] (not null) — MAX's edit endpoint doesn't reliably treat
  // a null attachments field as "clear", so an explicit empty array is used.
  const { text: requestText } = await renderDetail(session, request);
  await ctx.editMessage({ text: requestText, attachments: [] });
  await ackCallback(ctx);
  await ctx.reply(formatHouseInfoText(houseSummary, request.organization), {
    attachments: [buildHouseCardKeyboard(houseSummary.id, requestId, 'i')],
  });
}

export async function handleHouseTabSwitch(
  ctx: BotContext,
  houseId: number,
  requestId: number,
  tab: HouseTab,
) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  let text: string;
  let houseDetailForFiles: HouseDetail | null = null;

  if (tab === 'i') {
    const request = await getRequestDetail(session.token, requestId);
    const houseSummary = request ? extractHouseSummary(request) : null;
    if (!request || !houseSummary) {
      await ctx.answerOnCallback({ notification: 'Не удалось загрузить карточку дома' });
      return;
    }
    text = formatHouseInfoText(houseSummary, request.organization);
  } else {
    const house = await getHouseDetail(session.token, houseId);
    if (!house) {
      await ctx.answerOnCallback({ notification: 'Не удалось загрузить карточку дома' });
      return;
    }
    text = tab === 'e' ? formatHouseExtraText(house) : formatHouseFilesText(house);
    if (tab === 'f') houseDetailForFiles = house;
  }

  await ctx.editMessage({
    text,
    attachments: [buildHouseCardKeyboard(houseId, requestId, tab)],
  });
  await ackCallback(ctx);

  if (houseDetailForFiles) {
    const mediaAttachments = await buildHouseFilePreviewAttachments(
      session.token,
      houseDetailForFiles.files,
    );
    if (mediaAttachments.length > 0) {
      await ctx.reply('Медиафайлы дома:', { attachments: mediaAttachments });
    }
  }
}

export async function handleHouseCardBack(ctx: BotContext, requestId: number) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  // The house card message is discarded and the request card is re-sent
  // fresh, so the active keyboard moves back to that new message.
  await ctx.deleteMessage();
  await ackCallback(ctx);
  await reRenderDetailAsReply(ctx, session, requestId);
}
