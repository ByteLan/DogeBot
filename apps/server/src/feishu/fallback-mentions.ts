import type { FeishuBot } from '../types.js';
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
