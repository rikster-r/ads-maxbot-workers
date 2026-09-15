import 'dotenv/config';
import { bot } from './setup.js';
import { logger } from './logger.js';

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

logger.info('Starting bot (long polling)...');

bot.start().catch((err) => {
  logger.error({ err }, 'Polling error');
  process.exit(1);
});
