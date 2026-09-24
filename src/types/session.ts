import { BotState } from '../bot.js';

export interface SessionData {
  state: BotState;
  login: string | null;
  activeRequestId?: number | null;
  requestsTab?: 'new' | 'accepted' | 'completed';
  selectedFileIds?: number[];
}
