import { createRequire } from 'node:module';
import { logger } from '../logger.js';
import { invalidate } from '../requests/cache.js';
import { getWorkerDatabase } from '../db.js';
import { notifyAssignedWorkersOfNewApplication } from '../notifications/applicationCreated.js';
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
  const pusherUrl = process.env.PUSHER_URL;

  if (!key || !cluster || !pusherUrl) {
    logger.warn('PUSHER_KEY/PUSHER_CLUSTER/PUSHER_URL missing — realtime request updates disabled');
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
        endpoint: `${pusherUrl}/broadcasting/auth`,
        headersProvider: () => {
          const token = getWorkerDatabase().getAnyActiveSessionToken();
          return token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : {};
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

function bindSubscriptionLogging(channel: PusherChannel, channelName: string): void {
  channel.bind('pusher:subscription_succeeded', () => {
    logger.info({ channelName }, 'Pusher channel subscribed');
  });
  channel.bind('pusher:subscription_error', (error: unknown) => {
    logger.error({ channelName, err: error }, 'Pusher channel subscription failed');
  });
}

export function subscribeUserChannel(adsUserId: number): void {
  if (channels.has(adsUserId)) return;

  const pusher = getClient();
  if (!pusher) return;

  const channelName = `App.Models.User.${adsUserId}`;
  const channel = pusher.subscribe(channelName);
  bindSubscriptionLogging(channel, channelName);
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

const APPLICATIONS_CHANNEL = 'private-Twin.Applications';

/**
 * Subscribes once to the shared private applications channel and notifies
 * each newly-created application's assigned worker(s) in their chat.
 *
 * The channel is private, so its auth request borrows a worker's session
 * token. With no active session it's skipped, and a failed auth drops the
 * channel so the next login can retry — pusher-js never retries it itself.
 */
export function subscribeApplicationCreatedChannel(): void {
  if (applicationCreatedChannel) return;

  const pusher = getClient();
  if (!pusher) return;

  if (!getWorkerDatabase().getAnyActiveSessionToken()) {
    logger.info('No active session — deferring applications channel subscription until login');
    return;
  }

  const channel = pusher.subscribe(APPLICATIONS_CHANNEL);
  applicationCreatedChannel = channel;
  bindSubscriptionLogging(channel, APPLICATIONS_CHANNEL);
  channel.bind('pusher:subscription_error', () => {
    if (applicationCreatedChannel !== channel) return;
    pusher.unsubscribe(APPLICATIONS_CHANNEL);
    applicationCreatedChannel = null;
  });
  channel.bind('application.created', (data: unknown) => {
    logger.info({ data }, 'Received application.created event');
    notifyAssignedWorkersOfNewApplication(data as ApplicationCreatedPayload).catch((error) =>
      logger.error({ err: error }, 'Error notifying assigned workers of new application'),
    );
  });
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

  subscribeApplicationCreatedChannel();
}
