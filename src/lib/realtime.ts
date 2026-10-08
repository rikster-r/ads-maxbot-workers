import { createRequire } from 'node:module';
import { logger } from '../logger.js';
import { invalidate } from '../requests/cache.js';
import { getWorkerDatabase } from '../db.js';
import { notifyWorkerOfAssignedApplication } from '../notifications/applicationCreated.js';
import type { UserNotificationPayload } from '../notifications/applicationCreated.js';

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

const USER_CHANNEL_PREFIX = 'private-App.Models.User.';

function getClient(): PusherInstance | null {
  const key = process.env.PUSHER_KEY;
  const cluster = process.env.PUSHER_CLUSTER;
  const pusherUrl = process.env.PUSHER_URL;

  if (!key || !cluster || !pusherUrl) {
    logger.warn('PUSHER_KEY/PUSHER_CLUSTER/PUSHER_URL missing — realtime request updates disabled');
    return null;
  }

  if (!client) {
    // A custom handler instead of the built-in ajax transport, so each user
    // channel is authorized with its own user's token.
    const options = {
      cluster,
      channelAuthorization: {
        customHandler: (
          params: { socketId: string; channelName: string },
          callback: (error: Error | null, authData: unknown) => void,
        ) => {
          authorizeChannel(`${pusherUrl}/broadcasting/auth`, params.socketId, params.channelName)
            .then((authData) => callback(null, authData))
            .catch((error: Error) => callback(error, null));
        },
      },
    };
    client = new PusherClient(key, options) as PusherInstance;
    const connection = (client as unknown as { connection: PusherChannel }).connection;
    connection.bind('state_change', (states: unknown) => {
      logger.info({ states }, 'Pusher connection state changed');
    });
    connection.bind('error', (error: unknown) => {
      logger.error({ err: error }, 'Pusher connection error');
    });
  }

  return client;
}

/**
 * A user's private channel must be authorized with that user's own token.
 */
async function authorizeChannel(endpoint: string, socketId: string, channelName: string): Promise<unknown> {
  const adsUserId = Number(channelName.slice(USER_CHANNEL_PREFIX.length));
  const token = channelName.startsWith(USER_CHANNEL_PREFIX)
    ? getWorkerDatabase().getSessionTokenByAdsUserId(adsUserId)
    : null;

  if (!token) throw new Error(`No session token to authorize ${channelName}`);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ socket_id: socketId, channel_name: channelName }),
  });

  if (!response.ok) {
    throw new Error(`Channel auth for ${channelName} failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

/**
 * Subscribes to a worker's private channel. A failed auth drops the channel
 * so the next login can retry — pusher-js never retries it itself.
 */
export function subscribeUserChannel(adsUserId: number): void {
  if (channels.has(adsUserId)) return;

  const pusher = getClient();
  if (!pusher) return;

  const channelName = `${USER_CHANNEL_PREFIX}${adsUserId}`;
  const channel = pusher.subscribe(channelName);
  channels.set(adsUserId, channel);

  channel.bind('pusher:subscription_succeeded', () => {
    logger.info({ channelName }, 'Pusher channel subscribed');
  });
  channel.bind('pusher:subscription_error', (error: unknown) => {
    logger.error({ channelName, err: error }, 'Pusher channel subscription failed');
    if (channels.get(adsUserId) !== channel) return;
    pusher.unsubscribe(channelName);
    channels.delete(adsUserId);
  });

  channel.bind('application.updated', () => {
    invalidate(adsUserId);
  });
  channel.bind('notifications', (data: unknown) => {
    logger.info({ channelName, data }, 'Received user notification');
    invalidate(adsUserId);
    notifyWorkerOfAssignedApplication(adsUserId, data as UserNotificationPayload).catch((error) =>
      logger.error({ err: error }, 'Error notifying worker of assigned application'),
    );
  });
}

export function unsubscribeUserChannel(adsUserId: number): void {
  const pusher = client;
  if (!pusher) return;

  pusher.unsubscribe(`${USER_CHANNEL_PREFIX}${adsUserId}`);
  channels.delete(adsUserId);
}

/**
 * Re-subscribes every still-logged-in user's channel after a process
 * restart, since in-memory Pusher subscriptions don't survive PM2 restarts.
 */
export function bootstrapRealtimeSubscriptions(): void {
  try {
    const db = getWorkerDatabase();
    const sessions = db.getActiveSessions();
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
