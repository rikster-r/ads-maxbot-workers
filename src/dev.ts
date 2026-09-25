import 'dotenv/config';
import { bot } from './setup.js';
import { logger } from './logger.js';
import { clearWebhook } from './lib/webhook.js';

bot.catch((err: unknown) => {
  logger.error({ err }, 'Bot error');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down...');
  bot.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main(): Promise<void> {
  // A webhook (e.g. still registered by a VPS deployment) takes priority
  // over long polling, so updates would silently go there instead of here.
  await clearWebhook(process.env.BOT_TOKEN!);

  logger.info('Starting bot (long polling)...');
  await bot.start();
}

main().catch((err) => {
  logger.error({ err }, 'Polling error');
  process.exit(1);
});
