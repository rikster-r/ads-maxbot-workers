import { BotContext, BotState } from './bot.js';
import { getWorkerDatabase } from './db.js';
import { loginToAPI, getProfile } from './lib/apiFunctions.js';
import { isUser } from './constants/roles.js';
import { subscribeUserChannel } from './lib/realtime.js';
import { handleRequestsList } from './requests/list.js';
import { logger } from './logger.js';

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
  if (profile) {
    db.saveProfile(userId, profile.id, profile.role, profile.name);

    if (isUser(profile.role)) {
      subscribeUserChannel(profile.id);
      await ctx.reply('✅ Авторизация успешно завершена!');
      await handleRequestsList(ctx);
      return;
    }
  }

  await ctx.reply('✅ Авторизация успешно завершена!');

  if (profile && !isUser(profile.role)) {
    await ctx.reply('Извините, бот доступен только для исполнителей');
  }
}
