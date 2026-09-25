import { ackCallback, BotContext } from '../bot.js';
import { changeRequestStatus } from '../lib/requestsApi.js';
import { invalidate } from './cache.js';
import { reRenderDetailAsReply } from './detail.js';
import { requireFieldWorker } from './list.js';

// Kept after success too: a second tap can arrive before the button removal reaches the client.
const acceptedRequestIds = new Set<number>();

export async function handleAcceptApplication(ctx: BotContext, requestId: number) {
  if (acceptedRequestIds.has(requestId)) {
    await ackCallback(ctx);
    return;
  }

  const session = await requireFieldWorker(ctx);
  if (!session) return;

  acceptedRequestIds.add(requestId);

  const ok = await changeRequestStatus(session.token, requestId, 'accepted_by_executor');
  invalidate(session.adsUserId);
  if (!ok) {
    acceptedRequestIds.delete(requestId);
    await ctx.answerOnCallback({ notification: 'Не удалось принять заявку' });
    return;
  }

  const originalText = ctx.message?.body?.text ?? '';
  await ctx.editMessage({ text: `${originalText}\n\n✅ Принято`, attachments: null });
  await ackCallback(ctx, 'Принято');

  ctx.session = { ...ctx.session, activeRequestId: requestId };
  await reRenderDetailAsReply(ctx, session, requestId);
}
