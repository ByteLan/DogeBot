import type { RecentChatMessage } from '../types.js';

const RECENT_CHAT_MEMORY_LIMIT = 30;
const recentChatMessages = new Map<string, RecentChatMessage[]>();

function recentChatKey(botId: number, chatId: string) {
  return `${botId}:${chatId}`;
}

export function readRecentChatMessages(botId: number, chatId: string, limit: number) {
  const list = recentChatMessages.get(recentChatKey(botId, chatId)) || [];
  return list.slice(-limit);
}

export function rememberRecentChatMessage(botId: number, chatId: string, senderId: string, senderName: string, text: string) {
  if (!chatId || !text) return;
  const key = recentChatKey(botId, chatId);
  const list = recentChatMessages.get(key) || [];
  list.push({
    senderId,
    senderName,
    text,
    createdAt: Date.now()
  });
  recentChatMessages.set(key, list.slice(-RECENT_CHAT_MEMORY_LIMIT));
}
