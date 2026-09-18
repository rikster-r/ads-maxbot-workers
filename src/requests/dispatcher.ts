import { ackCallback, BotContext } from '../bot.js';
import { getWorkerDatabase } from '../db.js';
import { isViewer } from '../constants/roles.js';
import { changeRequestStatus } from '../lib/requestsApi.js';

interface DispatcherSession {
  token: string;
  name: string;
}

async function requireDispatcher(ctx: BotContext): Promise<DispatcherSession | null> {
  const maxUserId = ctx.user?.user_id;
  if (!maxUserId) {
    await ctx.reply('🔐 Сначала авторизуйтесь: /start');
    return null;
  }

  const db = getWorkerDatabase();
  const session = db.getSession(maxUserId);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    await ctx.reply('🔐 Сессия истекла, авторизуйтесь заново: /start');
    return null;
  }

  if (!session.role || !isViewer(session.role)) {
    await ctx.reply('Извините, это действие доступно только диспетчерам');
    return null;
  }

  return { token: session.token, name: session.name ?? 'диспетчер' };
}

export async function handleAcceptApplication(ctx: BotContext, requestId: number) {
  const session = await requireDispatcher(ctx);
  if (!session) return;

  const ok = await changeRequestStatus(session.token, requestId, 'accepted_by_executor');
  if (!ok) {
    await ctx.answerOnCallback({ notification: 'Не удалось принять заявку' });
    return;
  }

  const originalText = ctx.message?.body?.text ?? '';
  await ctx.editMessage({
    text: `${originalText}\n\n✅ Принято диспетчером ${session.name}`,
    attachments: null,
  });
  await ackCallback(ctx, 'Принято');
}
