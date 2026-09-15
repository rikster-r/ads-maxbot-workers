import { BotState } from '../bot.js';

export interface SessionData {
  state: BotState;
  login: string | null;
}
