import { bot } from './bot.js';
import { handleStart, handleTextMessage } from './handlers.js';
import { handleLogoutCancel, handleLogoutCommand, handleLogoutConfirm } from './auth.js';
import { handleRequestsList, handleTabAction } from './requests/list.js';
import {
  handleAddMediaButton,
  handleBackToDetail,
  handleCommentButton,
  handleDeleteFilesEntry,
  handleDeleteSelectedAsk,
  handleDeleteSelectedBack,
  handleDeleteSelectedConfirm,
  handleFileToggle,
  handleHouseCardButton,
  handleMediaDone,
  handleOpenRequest,
  handleStatusAction,
  handleStatusCancel,
  handleStatusConfirm,
  handleWorkDoneSkip,
} from './requests/detail.js';
import { bootstrapRealtimeSubscriptions } from './lib/realtime.js';
import { handleAcceptApplication } from './requests/dispatcher.js';

bot.on('bot_started', handleStart);
bot.command('start', handleStart);
bot.command('requests', handleRequestsList);
bot.command('logout', handleLogoutCommand);
bot.on('message_created', handleTextMessage);

bot.action('lo:y', handleLogoutConfirm);
bot.action('lo:n', handleLogoutCancel);

bot.action(/^rl:(new|accepted|completed)$/, (ctx) =>
  handleTabAction(ctx, ctx.match![1] as 'new' | 'accepted' | 'completed'),
);
bot.action(/^ro:(\d+)$/, (ctx) => handleOpenRequest(ctx, Number(ctx.match![1])));
bot.action(/^rs:(\d+)$/, (ctx) => handleStatusAction(ctx, Number(ctx.match![1])));
bot.action(/^rsc:(\d+):(.+)$/, (ctx) =>
  handleStatusConfirm(ctx, Number(ctx.match![1]), ctx.match![2]),
);
bot.action(/^rsx:(\d+)$/, (ctx) => handleStatusCancel(ctx, Number(ctx.match![1])));
bot.action(/^rm:(\d+)$/, (ctx) => handleAddMediaButton(ctx, Number(ctx.match![1])));
bot.action(/^rh:(\d+)$/, (ctx) => handleHouseCardButton(ctx, Number(ctx.match![1])));
bot.action(/^rmd:(\d+)$/, (ctx) => handleMediaDone(ctx, Number(ctx.match![1])));
bot.action(/^rc:(\d+)$/, (ctx) => handleCommentButton(ctx, Number(ctx.match![1])));
bot.action(/^rws:(\d+)$/, (ctx) => handleWorkDoneSkip(ctx, Number(ctx.match![1])));
bot.action(/^rdf:(\d+)$/, (ctx) => handleDeleteFilesEntry(ctx, Number(ctx.match![1])));
bot.action(/^rdt:(\d+):(\d+)$/, (ctx) =>
  handleFileToggle(ctx, Number(ctx.match![1]), Number(ctx.match![2])),
);
bot.action(/^rda:(\d+)$/, (ctx) => handleDeleteSelectedAsk(ctx, Number(ctx.match![1])));
bot.action(/^rdy:(\d+)$/, (ctx) => handleDeleteSelectedConfirm(ctx, Number(ctx.match![1])));
bot.action(/^rdb:(\d+)$/, (ctx) => handleDeleteSelectedBack(ctx, Number(ctx.match![1])));
bot.action(/^rb:(\d+)$/, (ctx) => handleBackToDetail(ctx, Number(ctx.match![1])));
bot.action(/^ac:(\d+)$/, (ctx) => handleAcceptApplication(ctx, Number(ctx.match![1])));

bot.api.setMyCommands([
  { name: 'start', description: 'Авторизация' },
  { name: 'requests', description: 'Мои заявки' },
  { name: 'logout', description: 'Выход' },
]);

bootstrapRealtimeSubscriptions();

export { bot };
