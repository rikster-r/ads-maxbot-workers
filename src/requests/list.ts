import { ackCallback, BotContext } from '../bot.js';
import { getWorkerDatabase } from '../db.js';
import { formatPriority, priorityRank } from '../constants/requestPriority.js';
import { tabLabels, userStatusMap } from '../constants/requestStatus.js';
import { getFullHouseAddress } from '../lib/houses.js';
import { getCachedUserRequests } from './cache.js';
import { buildListKeyboard } from './keyboards.js';
import type { RequestRecord } from '../lib/requestsApi.js';

type Tab = 'new' | 'accepted' | 'completed';

export interface WorkerSession {
  token: string;
  adsUserId: number;
}

/**
 * Guards any /requests entry point or req:* action: not logged in or no
 * profile both short-circuit here.
 */
export async function requireFieldWorker(ctx: BotContext): Promise<WorkerSession | null> {
  const maxUserId = ctx.user?.user_id;
  if (!maxUserId) {
    await ctx.reply('🔐 Сначала авторизуйтесь: /start');
    return null;
  }

  const db = getWorkerDatabase();
  const session = db.getSession(maxUserId);
  if (!session) {
    await ctx.reply('🔐 Сначала авторизуйтесь: /start');
    return null;
  }

  if (!session.ads_user_id) {
    await ctx.reply('🔐 Не удалось получить профиль. Авторизуйтесь заново: /start');
    return null;
  }

  return { token: session.token, adsUserId: session.ads_user_id };
}

function bucketByTab(requests: RequestRecord[], tab: Tab): RequestRecord[] {
  return requests
    .filter((r) => userStatusMap[tab].includes(r.status))
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || b.id - a.id);
}

function formatRequestLine(request: RequestRecord, index: number): string {
  const person = request.customer || request.applicant || '—';
  return `${index + 1}. #${request.id} — ${getFullHouseAddress(request)}\n${formatPriority(request.priority)}\n👤 ${person} · ${request.created_at}`;
}

export function renderListMessage(
  tab: Tab,
  allRequests: RequestRecord[],
): { text: string; keyboard: ReturnType<typeof buildListKeyboard> } {
  const counts: Record<Tab, number> = {
    new: bucketByTab(allRequests, 'new').length,
    accepted: bucketByTab(allRequests, 'accepted').length,
    completed: bucketByTab(allRequests, 'completed').length,
  };

  const tabRequests = bucketByTab(allRequests, tab);

  const lines = [`📋 Заявки — ${tabLabels[tab]} (${tabRequests.length})`, ''];
  if (tabRequests.length === 0) {
    lines.push('Нет заявок в этой вкладке.');
  } else {
    tabRequests.forEach((request, index) => lines.push(formatRequestLine(request, index), ''));
  }

  return {
    text: lines.join('\n').trimEnd(),
    keyboard: buildListKeyboard(tab, tabRequests, counts),
  };
}

async function fetchAndRender(ctx: BotContext, session: WorkerSession, tab: Tab) {
  const requests = await getCachedUserRequests(session.token, session.adsUserId);
  if (!requests) {
    return { text: '❌ Не удалось загрузить заявки. Попробуйте позже.', keyboard: undefined };
  }
  return renderListMessage(tab, requests);
}

export async function handleRequestsList(ctx: BotContext) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  const tab: Tab = 'new';
  ctx.session = { ...ctx.session, requestsTab: tab };

  const { text, keyboard } = await fetchAndRender(ctx, session, tab);
  await ctx.reply(text, keyboard ? { attachments: [keyboard] } : undefined);
}

export async function handleTabAction(ctx: BotContext, tab: Tab) {
  const session = await requireFieldWorker(ctx);
  if (!session) return;

  ctx.session = { ...ctx.session, requestsTab: tab };

  const { text, keyboard } = await fetchAndRender(ctx, session, tab);
  await ctx.editMessage({ text, attachments: keyboard ? [keyboard] : null });
  await ackCallback(ctx);
}
