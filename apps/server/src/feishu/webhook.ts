import type { Request, Response as ExpressResponse } from 'express';
import type { FeishuBot } from '../types.js';
import { getBot } from './bot-management.js';
import { handleFeishuMessage } from './message-handler.js';
import { handleFeishuCardAction } from './card-action.js';

export async function feishuWebhook(req: Request, res: ExpressResponse) {
  const bot = getBot(Number(req.params.id));
  if (!bot || !bot.enabled) {
    res.status(404).json({ error: 'bot not found' });
    return;
  }

  const payload = req.body || {};
  if (payload.type === 'url_verification') {
    res.json({ challenge: payload.challenge || '' });
    return;
  }

  const incomingToken = String(payload.header?.token || payload.token || '');
  if (bot.verification_token && incomingToken !== bot.verification_token) {
    res.status(401).send('Invalid verification token');
    return;
  }

  const eventType = payload.header?.event_type || payload.type;
  if (eventType === 'im.message.receive_v1') {
    const eventId = String(payload.header?.event_id || payload.event?.message?.message_id || '').trim();
    const messageId = String(payload.event?.message?.message_id || '').trim();
    handleFeishuMessage(bot, payload.event).catch((error) => {
      console.error('[feishu] message handling failed', {
        botId: bot.id,
        messageId,
        eventId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  if (eventType === 'card.action.trigger') {
    const eventId = String(payload.header?.event_id || '').trim();
    const messageId = String(payload.event?.context?.open_message_id || '').trim();
    void Promise.resolve()
      .then(() => handleFeishuCardAction(bot, payload))
      .catch((error) => {
        console.error('[feishu] card action handling failed', {
          botId: bot.id,
          messageId,
          eventId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    res.json({ toast: { type: 'info', content: '正在生成，请稍等' } });
    return;
  }

  res.json({ ok: true });
}
