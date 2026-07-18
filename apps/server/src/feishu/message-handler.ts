import type { FeishuBot } from '../types.js';
import { passiveInteractionConfig } from '../config.js';
import { parseFeishuMessage, messageChatId, senderIdentity, messageMentionsBot, isFromCurrentBot, isThreadMessage, referencedMessageIds } from './message-parser.js';
import { readRecentChatMessages, rememberRecentChatMessage } from './chat-memory.js';
import { rememberFeishuEventKey } from './event-dedup.js';
import { isTopicChat, replyText, fetchMessageById } from './api.js';
import { runPassiveInteractions } from './passive/index.js';
import { handleFeishuCommand } from './commands/index.js';
import { getDefaultCommand } from './commands/douyin.js';
import { fallbackMentionCandidates, fallbackMentionCardEnabled } from './fallback-mentions.js';
import { replyFallbackMentionCard } from './cards/fallback-mention-card.js';
import { extractAwemeIdFromText, reportPossiblyInvalidAweme } from './douyin-guard.js';

const DOUYIN_INVALID_KEYWORDS = ['视频无效', '视频失效'];

/**
 * Resolve the aweme_id a "视频无效/视频失效" report refers to: prefer the current
 * message text, otherwise fall back to the referenced (quoted) message text.
 */
async function resolveReportedAwemeId(bot: FeishuBot, message: any, currentText: string) {
  const fromCurrent = extractAwemeIdFromText(currentText);
  if (fromCurrent) return fromCurrent;
  for (const referencedMessageId of referencedMessageIds(message)) {
    const referenced = await fetchMessageById(bot, referencedMessageId).catch(() => undefined);
    if (!referenced) continue;
    const referencedText = parseFeishuMessage(referenced.message).text;
    const fromReferenced = extractAwemeIdFromText(referencedText);
    if (fromReferenced) return fromReferenced;
  }
  return '';
}

export async function handleFeishuMessage(bot: FeishuBot, event: any) {
  const message = event?.message;
  const messageId = message?.message_id;
  const parsedMessage = parseFeishuMessage(message);
  const text = parsedMessage.text;
  if (!messageId) return;
  const dedupKey = `message:${messageId}`;
  if (!rememberFeishuEventKey(dedupKey)) return;
  if (isFromCurrentBot(bot, event)) return;

  const chatId = messageChatId(message);
  const chatType = String(message?.chat_type || '').trim();
  const isPrivateChat = chatType === 'p2p';
  const mentionsBot = messageMentionsBot(bot, message);
  const shouldHandleCommand = isPrivateChat || mentionsBot;

  const history = chatId ? readRecentChatMessages(bot.id, chatId, passiveInteractionConfig().contextSize) : [];
  const sender = senderIdentity(event);
  if (text) rememberRecentChatMessage(bot.id, chatId, sender.id, sender.name, parsedMessage.textForRepeat || text);

  if (text && DOUYIN_INVALID_KEYWORDS.some((keyword) => text.includes(keyword))) {
    const awemeId = await resolveReportedAwemeId(bot, message, text);
    if (awemeId) {
      const handled = await reportPossiblyInvalidAweme(bot, awemeId, {
        chatId,
        personId: sender.id,
        personName: sender.name,
        source: '群聊"视频无效/失效"上报'
      });
      if (handled) return;
    }
  }

  if (shouldHandleCommand && text) {
    if (await handleFeishuCommand(bot, event, messageId, text, { allowSetDefault: true })) {
      return;
    }

    const defaultCommand = getDefaultCommand(bot.id);
    if (defaultCommand) {
      const fallbackHandled = await handleFeishuCommand(bot, event, messageId, defaultCommand, { allowSetDefault: false });
      if (!fallbackHandled) {
        await replyText(bot, messageId, defaultCommand);
      }
      const candidates = fallbackMentionCardEnabled(bot.id, chatId)
        ? await fallbackMentionCandidates(bot, message)
        : [];
      if (candidates.length > 0) {
        const showSendToGroup = Boolean(chatId) && !isThreadMessage(message) && (
          chatType === 'p2p' ||
          (chatType === 'group' && await isTopicChat(bot, chatId).then((topic) => !topic).catch(() => false))
        );
        await replyFallbackMentionCard(bot, messageId, candidates, {
          sourceMessageId: messageId,
          atById: sender.id,
          atByName: sender.name,
          showSendToGroup
        });
      }
      return;
    }
  }

  await runPassiveInteractions(bot, event, messageId, parsedMessage, history);
}
