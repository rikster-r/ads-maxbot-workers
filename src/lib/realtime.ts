import { createRequire } from 'node:module';
import { logger } from '../logger.js';
import { invalidate } from '../requests/cache.js';
import { getWorkerDatabase } from '../db.js';
import { adminRoles, userRoles, viewerRoles } from '../constants/roles.js';
import { notifyDispatchersOfNewApplication } from '../notifications/applicationCreated.js';
import type { ApplicationCreatedPayload } from '../notifications/applicationCreated.js';

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
let applicationCreatedChannel: PusherChannel | null = null;

function getClient(): PusherInstance | null {
  const key = process.env.PUSHER_KEY;
  const cluster = process.env.PUSHER_CLUSTER;

  if (!key || !cluster) {
    logger.warn('PUSHER_KEY/PUSHER_CLUSTER missing — realtime request updates disabled');
    return null;
  }

  if (!client) {
    // pusher-js's shipped Options type doesn't include headersProvider despite
    // the runtime supporting it (confirmed in dist/node/pusher.js), so the
    // options object is built loosely typed here.
    const options = {
      cluster,
      channelAuthorization: {
        transport: 'ajax',
        endpoint: `${process.env.API_URL}/broadcasting/auth`,
        headersProvider: () => {
          const token = getWorkerDatabase().getAnyActiveSessionToken([...viewerRoles, ...adminRoles]);
          return token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : {};
        },
      },
    };
    client = new PusherClient(key, options) as PusherInstance;
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
 * Subscribes once to the shared private dispatcher-notifications channel and
 * fans new applications out to every active dispatcher's chat.
 */
export function subscribeApplicationCreatedChannel(): void {
  if (applicationCreatedChannel) return;

  const pusher = getClient();
  if (!pusher) return;

  applicationCreatedChannel = pusher.subscribe('private-Twin.Applications');
  applicationCreatedChannel.bind('application.created', (data: unknown) => {
    notifyDispatchersOfNewApplication(data as ApplicationCreatedPayload).catch((error) =>
      logger.error({ err: error }, 'Error notifying dispatchers of new application'),
    );
  });
}

/**
 * Re-subscribes every still-logged-in field worker's channel after a
 * process restart, since in-memory Pusher subscriptions don't survive PM2 restarts.
 */
export function bootstrapRealtimeSubscriptions(): void {
  try {
    const db = getWorkerDatabase();
    const sessions = db.getActiveSessionsByRoles(userRoles);
    for (const session of sessions) {
      if (session.ads_user_id) subscribeUserChannel(session.ads_user_id);
    }
    if (sessions.length > 0) {
      logger.info({ count: sessions.length }, 'Resubscribed Pusher channels for active sessions');
    }
  } catch (error) {
    logger.error({ err: error }, 'Error bootstrapping Pusher subscriptions');
  }

  subscribeApplicationCreatedChannel();
}
