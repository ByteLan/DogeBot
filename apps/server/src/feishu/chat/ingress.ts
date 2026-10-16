import type { FeishuBot } from '../../types.js';
import { handleFeishuMessage } from '../message-handler.js';
import { rememberFeishuEventKey } from '../event-dedup.js';
import { publishChatEvent } from './events.js';
import { normalizeMessage, record, string } from './normalize.js';

export async function dispatchFeishuMessage(bot: FeishuBot, value: unknown) {
  const event = record(value);
  const raw = record(event.message);
  const id = string(raw.message_id);
  if (id && rememberFeishuEventKey(`chat-message:${bot.id}:${id}`)) {
    const message = normalizeMessage(bot.id, raw, event.sender);
    if (message) publishChatEvent(bot, { type: 'message.upsert', botId: bot.id, message });
  }
  await handleFeishuMessage(bot, value);
}

export function dispatchFeishuRecall(bot: FeishuBot, value: unknown) {
  const event = record(value);
  const chatId = string(event.chat_id);
  const messageId = string(event.message_id);
  if (!chatId || !messageId || !rememberFeishuEventKey(`chat-recall:${bot.id}:${messageId}`)) return;
  const recallTime = Number(event.recall_time);
  publishChatEvent(bot, { type: 'message.recalled', botId: bot.id, chatId, messageId, recallTimeMs: Number.isFinite(recallTime) && recallTime > 0 ? recallTime : Date.now() });
}
