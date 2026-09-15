import { bot } from './bot.js';
import { handleStart, handleTextMessage } from './handlers.js';

bot.on('bot_started', handleStart);
bot.command('start', handleStart);
bot.on('message_created', handleTextMessage);

bot.api.setMyCommands([{ name: 'start', description: 'Авторизация' }]);

export { bot };
