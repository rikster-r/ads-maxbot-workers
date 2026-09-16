import { createRequire } from 'node:module';
import { logger } from '../logger.js';
import { invalidate } from '../requests/cache.js';
import { getWorkerDatabase } from '../db.js';
import { userRoles } from '../constants/roles.js';

// pusher-js's shipped .d.ts doesn't resolve cleanly as a default import under
// NodeNext + a CJS-only package (TS2709 "Cannot use namespace as a type"), so
// load it via plain require and keep its shape loosely typed here.
const require = createRequire(import.meta.url);
const PusherClient = require('pusher-js');

interface PusherChannel {
  bind(eventName: string, callback: (data: unknown) => void): void;
}

interface PusherInstance {
  subscribe(channelName: string): PusherChannel;
  unsubscribe(channelName: string): void;
}

let client: PusherInstance | null = null;
const channels = new Map<number, PusherChannel>();

function getClient(): PusherInstance | null {
  const key = process.env.PUSHER_KEY;
  const cluster = process.env.PUSHER_CLUSTER;

  if (!key || !cluster) {
    logger.warn('PUSHER_KEY/PUSHER_CLUSTER missing — realtime request updates disabled');
    return null;
  }

  if (!client) {
    client = new PusherClient(key, { cluster }) as PusherInstance;
  }

  return client;
}

export function subscribeUserChannel(adsUserId: number): void {
  if (channels.has(adsUserId)) return;

  const pusher = getClient();
  if (!pusher) return;

  const channel = pusher.subscribe(`App.Models.User.${adsUserId}`);
  channel.bind('application.updated', () => {
    invalidate(adsUserId);
  });

  channels.set(adsUserId, channel);
}

export function unsubscribeUserChannel(adsUserId: number): void {
  const pusher = client;
  if (!pusher) return;

  pusher.unsubscribe(`App.Models.User.${adsUserId}`);
  channels.delete(adsUserId);
}

/**
 * Re-subscribes every still-logged-in field worker's channel after a
 * process restart, since in-memory Pusher subscriptions don't survive PM2 restarts.
 */
export function bootstrapRealtimeSubscriptions(): void {
  try {
    const db = getWorkerDatabase();
    const sessions = db.getActiveFieldWorkerSessions(userRoles);
    for (const session of sessions) {
      if (session.ads_user_id) subscribeUserChannel(session.ads_user_id);
    }
    if (sessions.length > 0) {
      logger.info({ count: sessions.length }, 'Resubscribed Pusher channels for active sessions');
    }
  } catch (error) {
    logger.error({ err: error }, 'Error bootstrapping Pusher subscriptions');
  }
}
