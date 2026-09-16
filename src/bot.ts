import { Bot, Context } from '@maxhub/max-bot-api';
import { getSession, setSession } from './session.js';
import { SessionData } from './types/session.js';

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is missing');
}

if (!process.env.API_URL) {
  throw new Error('API_URL is missing');
}

export class BotContext extends Context {
  get session(): SessionData {
    if (!this.user?.user_id) throw new Error('No user_id on context');
    return getSession(this.user.user_id);
  }

  set session(data: SessionData) {
    if (!this.user?.user_id) throw new Error('No user_id on context');
    setSession(this.user.user_id, data);
  }
}

export enum BotState {
  IDLE = 'idle',
  WAITING_LOGIN = 'waiting_login',
  WAITING_PASSWORD = 'waiting_password',
  WAITING_COMMENT = 'waiting_comment',
  WAITING_MEDIA = 'waiting_media',
}

// The SDK defaults its internal client (getMyInfo, sendMessage, etc.) to
// platform-api2.max.ru, whose cert chains to Russia's domestic root CA and
// isn't trusted outside RU. platform-api.max.ru (v1) uses a globally-trusted
// cert and still works, so point the client there instead.
export const bot = new Bot<BotContext>(process.env.BOT_TOKEN!, {
  contextType: BotContext,
  clientOptions: { baseUrl: 'https://platform-api.max.ru' },
});

export function resetSession(ctx: BotContext) {
  ctx.session = {
    state: BotState.IDLE,
    login: null,
  };
}

/**
 * Acknowledges a callback button press. The MAX API rejects
 * answerOnCallback with neither `message` nor `notification` set (400
 * "proto.payload"), so a silent ack still needs a non-empty notification.
 */
export function ackCallback(ctx: BotContext, notification = '✓') {
  return ctx.answerOnCallback({ notification });
}
