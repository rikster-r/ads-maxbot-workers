import { logger } from '../logger.js';

const MAX_API_BASE = 'https://platform-api.max.ru';

interface Subscription {
  url: string;
}

async function getSubscriptions(botToken: string): Promise<Subscription[]> {
  const res = await fetch(`${MAX_API_BASE}/subscriptions`, {
    headers: { Authorization: botToken },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET /subscriptions failed ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { subscriptions?: Subscription[] };
  return data.subscriptions ?? [];
}

/**
 * MAX only delivers updates to one place at a time: whichever subscription
 * (webhook) is currently registered. Switching between webhook mode (VPS)
 * and long polling (local dev) without clearing the old subscription leaves
 * updates going to the dead webhook, so the "new" bot looks unresponsive.
 * Both entrypoints call this before they start receiving updates.
 *
 * DELETE /subscriptions removes one subscription by its `url` — there's no
 * "delete all" — so existing subscriptions are listed first and each is
 * deleted individually.
 */
export async function clearWebhook(botToken: string): Promise<void> {
  let subscriptions: Subscription[];
  try {
    subscriptions = await getSubscriptions(botToken);
  } catch (err) {
    logger.warn({ err }, 'GET /subscriptions failed');
    return;
  }

  if (subscriptions.length === 0) {
    logger.info('No existing webhook subscription to clear');
    return;
  }

  for (const { url } of subscriptions) {
    try {
      const res = await fetch(
        `${MAX_API_BASE}/subscriptions?url=${encodeURIComponent(url)}`,
        { method: 'DELETE', headers: { Authorization: botToken } },
      );
      if (!res.ok && res.status !== 404) {
        const body = await res.text();
        logger.warn(
          { status: res.status, body, url },
          'DELETE /subscriptions returned non-OK status',
        );
        continue;
      }
      logger.info({ url }, 'Cleared webhook subscription');
    } catch (err) {
      logger.warn({ err, url }, 'DELETE /subscriptions failed');
    }
  }
}

export async function registerWebhook(
  botToken: string,
  webhookUrl: string,
  webhookSecret: string,
): Promise<void> {
  await clearWebhook(botToken);

  const postRes = await fetch(`${MAX_API_BASE}/subscriptions`, {
    method: 'POST',
    headers: {
      Authorization: botToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: webhookUrl, secret: webhookSecret }),
  });

  if (!postRes.ok) {
    const body = await postRes.text();
    throw new Error(`POST /subscriptions failed ${postRes.status}: ${body}`);
  }

  logger.info('Webhook registered successfully');
}
