import type { FeishuBot } from '../../types.js';
import type { ChatEvent } from './types.js';
import { normalizeMessage, record, string } from './normalize.js';

type Listener = (event: ChatEvent) => void;
const listeners = new Map<number, Set<Listener>>();

export function subscribeChatEvents(userId: number, listener: Listener) {
  const set = listeners.get(userId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(userId, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(userId); };
}

export function publishChatEvent(bot: FeishuBot, event: ChatEvent) {
  if (bot.user_id == null) return;
  for (const listener of listeners.get(bot.user_id) ?? []) {
    try { listener(event); }
    catch (error) {
      console.error('[feishu] chat event delivery failed', { botId: bot.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function publishMessageResult(bot: FeishuBot, result: unknown, clientRequestId?: string) {
  const raw = record(result);
  const data = raw.data ?? result;
  const message = normalizeMessage(bot.id, data);
  if (message) {
    publishChatEvent(bot, { type: 'message.upsert', botId: bot.id, message, clientRequestId });
    if (message.msgType === 'interactive') publishMessageRefresh(bot, message.messageId, message.chatId);
  }
  else publishChatEvent(bot, { type: 'message.refresh', botId: bot.id, messageId: string(record(data).message_id) || undefined });
}

export function publishMessageRefresh(bot: FeishuBot, messageId?: string, chatId?: string) {
  publishChatEvent(bot, { type: 'message.refresh', botId: bot.id, chatId, messageId });
}
