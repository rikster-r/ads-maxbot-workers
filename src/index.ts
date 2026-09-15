import 'dotenv/config';
import express from 'express';
import { bot } from './setup.js';
import { logger } from './logger.js';

const { BOT_TOKEN, WEBHOOK_URL, WEBHOOK_SECRET, PORT } = process.env;

if (!WEBHOOK_URL) throw new Error('WEBHOOK_URL is missing');
if (!WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET is missing');
if (!PORT) throw new Error('PORT is missing');
if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing');
if (!/^[A-Za-z0-9_-]{5,256}$/.test(WEBHOOK_SECRET)) {
  throw new Error('WEBHOOK_SECRET must be 5–256 chars [A-Za-z0-9_-]');
}

const MAX_API_BASE = 'https://platform-api.max.ru';

bot.catch((err: unknown) => {
  logger.error({ err }, 'Bot error');
});

async function registerWebhook(): Promise<void> {
  try {
    const deleteRes = await fetch(`${MAX_API_BASE}/subscriptions`, {
      method: 'DELETE',
      headers: { Authorization: BOT_TOKEN! },
    });
    if (!deleteRes.ok && deleteRes.status !== 404) {
      logger.warn(
        { status: deleteRes.status },
        'DELETE /subscriptions returned non-OK status',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'DELETE /subscriptions failed');
  }

  const postRes = await fetch(`${MAX_API_BASE}/subscriptions`, {
    method: 'POST',
    headers: {
      Authorization: BOT_TOKEN!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: WEBHOOK_URL, secret: WEBHOOK_SECRET }),
  });

  if (!postRes.ok) {
    const body = await postRes.text();
    throw new Error(`POST /subscriptions failed ${postRes.status}: ${body}`);
  }

  logger.info('Webhook registered successfully');
}

async function main(): Promise<void> {
  (bot as any).botInfo = await bot.api.getMyInfo();

  const app = express();
  app.use(express.json());

  const webhookPath = new URL(WEBHOOK_URL!).pathname;

  app.post(webhookPath, async (req, res) => {
    const incomingSecret = req.headers['x-max-bot-api-secret'];
    if (incomingSecret !== WEBHOOK_SECRET) {
      logger.warn('Rejected webhook request: invalid secret');
      res.status(403).end();
      return;
    }

    try {
      await (bot as any).handleUpdate(req.body);
    } catch (err) {
      logger.error({ err }, 'Unhandled error in handleUpdate');
    }

    res.status(200).end();
  });

  const server = app.listen(Number(PORT));
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  logger.info({ port: PORT }, 'Server listening');

  await registerWebhook();
  logger.info('Bot started successfully!');

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down...');
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  logger.error({ err }, 'Startup error');
  process.exit(1);
});
