import { BotState } from './bot.js';
import { SessionData } from './types/session.js';

const sessions = new Map<number, SessionData>();

function defaultSession(): SessionData {
  return {
    state: BotState.IDLE,
    login: null,
  };
}

export function getSession(userId: number): SessionData {
  if (!sessions.has(userId)) sessions.set(userId, defaultSession());
  return sessions.get(userId)!;
}

export function setSession(userId: number, data: SessionData): void {
  sessions.set(userId, data);
}

export function deleteSession(userId: number): void {
  sessions.delete(userId);
}
