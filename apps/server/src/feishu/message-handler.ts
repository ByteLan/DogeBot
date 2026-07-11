import type { FeishuBot } from '../types.js';
import { passiveInteractionConfig } from '../config.js';
import { parseFeishuMessage, messageChatId, senderIdentity, messageMentionsBot, isFromCurrentBot } from './message-parser.js';
import { readRecentChatMessages, rememberRecentChatMessage } from './chat-memory.js';
import { rememberFeishuEventKey } from './event-dedup.js';
import { replyText } from './api.js';
import { runPassiveInteractions } from './passive/index.js';
import { handleFeishuCommand } from './commands/index.js';
import { getDefaultCommand } from './commands/douyin.js';
import { fallbackMentionCandidates } from './fallback-mentions.js';
import { replyFallbackMentionCard } from './cards/fallback-mention-card.js';

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
      const candidates = await fallbackMentionCandidates(bot, message);
      if (candidates.length > 0) {
        await replyFallbackMentionCard(bot, messageId, candidates, {
          sourceMessageId: messageId,
          atById: sender.id,
          atByName: sender.name
        });
      }
      return;
    }
  }

  await runPassiveInteractions(bot, event, messageId, parsedMessage, history);
}
