import { BotContext, BotState, resetSession } from './bot.js';
import {
  isLoggedIn,
  startLoginFlow,
  handleLoginInput,
  handlePasswordInput,
} from './auth.js';

export async function handleStart(ctx: BotContext) {
  resetSession(ctx);

  const userId = ctx.user?.user_id;
  if (userId && isLoggedIn(userId)) {
    await ctx.reply('👋 Вы уже авторизованы.');
    return;
  }

  await ctx.reply(
    '👋 Здравствуйте! Для начала работы необходимо авторизоваться.',
  );
  await startLoginFlow(ctx);
}

export async function handleTextMessage(ctx: BotContext) {
  const state = ctx.session.state;
  const text = ctx.message?.body?.text;
  if (!text) return;

  switch (state) {
    case BotState.WAITING_LOGIN:
      await handleLoginInput(ctx, text);
      break;

    case BotState.WAITING_PASSWORD:
      await handlePasswordInput(ctx, text);
      break;

    default:
      break;
  }
}
