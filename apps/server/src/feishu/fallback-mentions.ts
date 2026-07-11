import type { FeishuBot } from '../types.js';
import { db } from '../db.js';
import { fetchMessageById } from './api.js';
import { mentionedUsers, referencedMessageIds } from './message-parser.js';
import type { FallbackMentionCandidate } from './cards/fallback-mention-card.js';

function addCandidates(
  candidates: Map<string, FallbackMentionCandidate>,
  mentions: FallbackMentionCandidate[]
) {
  for (const mention of mentions) {
    const id = mention.id.trim();
    if (!id || candidates.has(id)) continue;
    candidates.set(id, {
      id,
      name: mention.name.trim()
    });
  }
}

export function fallbackMentionCardEnabled(botId: number, chatId: string) {
  if (!chatId) return true;
  const row = db.prepare(`
    SELECT enabled
    FROM feishu_chat_fallback_mention_settings
    WHERE bot_id = ? AND chat_id = ?
  `).get(botId, chatId) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true;
}

export function setFallbackMentionCardEnabled(botId: number, chatId: string, enabled: boolean) {
  if (!chatId) return;
  db.prepare(`
    INSERT INTO feishu_chat_fallback_mention_settings (bot_id, chat_id, enabled)
    VALUES (?, ?, ?)
    ON CONFLICT(bot_id, chat_id) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = CURRENT_TIMESTAMP
  `).run(botId, chatId, enabled ? 1 : 0);
}

export async function fallbackMentionCandidates(bot: FeishuBot, message: any) {
  const candidates = new Map<string, FallbackMentionCandidate>();
  addCandidates(candidates, mentionedUsers(bot, message));

  const referencedMessages = await Promise.all(
    referencedMessageIds(message).map((messageId) => fetchMessageById(bot, messageId).catch(() => undefined))
  );
  for (const referencedMessage of referencedMessages) {
    if (referencedMessage?.message) {
      addCandidates(candidates, mentionedUsers(bot, referencedMessage.message));
    }
  }

  return [...candidates.values()];
}
