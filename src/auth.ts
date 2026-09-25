import { Keyboard } from '@maxhub/max-bot-api';
import { ackCallback, BotContext, BotState, resetSession } from './bot.js';
import { getWorkerDatabase } from './db.js';
import { loginToAPI, getProfile } from './lib/apiFunctions.js';
import { subscribeUserChannel, unsubscribeUserChannel } from './lib/realtime.js';
import { handleRequestsList } from './requests/list.js';
import { logger } from './logger.js';

const { inlineKeyboard, button } = Keyboard;

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Whether this Max user has a saved API token that hasn't expired yet
 */
export function isLoggedIn(maxUserId: number): boolean {
  try {
    const db = getWorkerDatabase();
    const session = db.getSession(maxUserId);
    if (!session) return false;

    return new Date(session.expires_at).getTime() > Date.now();
  } catch (error) {
    logger.error({ err: error }, 'Error reading worker session');
    return false;
  }
}

export async function startLoginFlow(ctx: BotContext) {
  ctx.session.state = BotState.WAITING_LOGIN;
  ctx.session.login = null;
  await ctx.reply('🔐 Авторизация\n\nВведите ваш логин:');
}

export async function handleLoginInput(ctx: BotContext, text: string) {
  const login = text.trim();

  if (!login) {
    await ctx.reply('Логин не может быть пустым. Введите ваш логин:');
    return;
  }

  ctx.session.login = login;
  ctx.session.state = BotState.WAITING_PASSWORD;
  await ctx.reply('Введите пароль:');
}

export async function handlePasswordInput(ctx: BotContext, text: string) {
  const login = ctx.session.login;
  if (!login) {
    await startLoginFlow(ctx);
    return;
  }

  const password = text.trim();
  if (!password) {
    await ctx.reply('Пароль не может быть пустым. Введите пароль:');
    return;
  }

  const userId = ctx.user?.user_id;
  if (!userId) {
    await ctx.reply('❌ Не удалось определить пользователя. Попробуйте /start заново.');
    return;
  }

  const token = await loginToAPI(login, password);

  if (!token) {
    ctx.session.login = null;
    ctx.session.state = BotState.WAITING_LOGIN;
    await ctx.reply('❌ Неверный логин или пароль. Введите логин еще раз:');
    return;
  }

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const db = getWorkerDatabase();
  try {
    db.saveSession(userId, login, token, expiresAt);
  } catch (error) {
    logger.error({ err: error }, 'Error saving worker session');
    await ctx.reply('❌ Произошла ошибка при сохранении авторизации. Попробуйте еще раз.');
    return;
  }

  ctx.session.state = BotState.IDLE;
  ctx.session.login = null;

  const profile = await getProfile(token);
  await ctx.reply('✅ Авторизация успешно завершена!');
  if (!profile) return;

  db.saveProfile(userId, profile.id, profile.role, profile.name);
  subscribeUserChannel(profile.id);
  await handleRequestsList(ctx);
}

function buildLogoutConfirmKeyboard() {
  return inlineKeyboard([[button.callback('Да', 'lo:y'), button.callback('Отмена', 'lo:n')]]);
}

export async function handleLogoutCommand(ctx: BotContext) {
  const userId = ctx.user?.user_id;
  if (!userId || !isLoggedIn(userId)) {
    await ctx.reply('Вы не авторизованы.');
    return;
  }

  await ctx.reply('Вы уверены, что хотите выйти?', {
    attachments: [buildLogoutConfirmKeyboard()],
  });
}

export async function handleLogoutConfirm(ctx: BotContext) {
  const userId = ctx.user?.user_id;
  if (!userId) {
    await ackCallback(ctx);
    return;
  }

  const db = getWorkerDatabase();
  const session = db.getSession(userId);
  if (session?.ads_user_id) {
    unsubscribeUserChannel(session.ads_user_id);
  }
  db.deleteSession(userId);
  resetSession(ctx);

  await ctx.editMessage({ text: '✅ Вы вышли из системы.', attachments: null });
  await ackCallback(ctx);
}

export async function handleLogoutCancel(ctx: BotContext) {
  await ctx.editMessage({ text: 'Действие отменено.', attachments: null });
  await ackCallback(ctx);
}
