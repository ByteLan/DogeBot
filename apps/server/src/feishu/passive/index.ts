import type { FeishuBot, ParsedFeishuMessage, RecentChatMessage, StyleStickerFeature } from '../../types.js';
import type { StickerFlavor } from '../../styleStickerCore.js';
import { passiveInteractionConfig } from '../../config.js';
import { randomItem, triggerDecision } from '../../utils/random.js';
import { replyText, replyMedia, sendTextToChat, sendImageToChat, sendStickerToChat, uploadImage } from '../api.js';
import { messageChatId, messageThreadId, messageMentionsBot } from '../message-parser.js';
import { renderStyleStickerImage } from '../../styleStickers.js';
import { getPassiveFeatureSetting, getStyleStickerSetting } from './settings.js';
import { generateImitationReply } from './llm-reply.js';
import { resolvePassiveMediaResource } from '../media/resource-cache.js';
import { buildMirroredImage } from '../media/mirror.js';
import { promises as fs } from 'node:fs';

function styleStickerFlavor(feature: StyleStickerFeature): StickerFlavor {
  return feature === 'byte_style' ? 'bs' : 'snh';
}

function styleStickerCommandName(feature: StyleStickerFeature) {
  return feature === 'byte_style' ? '/byte-style' : '/scale-new-heights';
}

async function sendPassiveText(bot: FeishuBot, event: any, messageId: string, text: string) {
  if (messageThreadId(event?.message)) {
    await replyText(bot, messageId, text, true);
    return;
  }
  const chatId = messageChatId(event?.message);
  if (chatId) {
    await sendTextToChat(bot, chatId, text);
    return;
  }
  await replyText(bot, messageId, text);
}

async function sendPassiveMedia(
  bot: FeishuBot,
  event: any,
  messageId: string,
  media: { type: 'image'; key: string } | { type: 'sticker'; key: string }
) {
  if (messageThreadId(event?.message)) {
    await replyMedia(bot, messageId, media, true);
    return;
  }
  const chatId = messageChatId(event?.message);
  if (chatId) {
    if (media.type === 'image') {
      await sendImageToChat(bot, chatId, media.key);
    } else {
      await sendStickerToChat(bot, chatId, media.key);
    }
    return;
  }
  await replyMedia(bot, messageId, media);
}

async function sendPassiveStyleSticker(
  bot: FeishuBot,
  event: any,
  messageId: string,
  feature: StyleStickerFeature,
  text: string
) {
  const { image } = await renderStyleStickerImage(text, styleStickerFlavor(feature));
  const imageKey = await uploadImage(bot, image, `${styleStickerCommandName(feature).slice(1)}.png`);
  await sendPassiveMedia(bot, event, messageId, { type: 'image', key: imageKey });
}

async function sendPassiveMediaRepeat(bot: FeishuBot, event: any, messageId: string, parsedMessage: ParsedFeishuMessage) {
  const chatId = messageChatId(event?.message);
  if (!chatId && !messageId) return;

  const media = await resolvePassiveMediaResource(bot, messageId, chatId || 'unknown_chat', parsedMessage);
  if (!media) return;

  if (media.sourceType === 'image') {
    const uploadedImageKey = await uploadImage(bot, media.resource.data, media.resource.fileName);
    await sendPassiveMedia(bot, event, messageId, { type: 'image', key: uploadedImageKey });
    return;
  }

  await sendPassiveMedia(bot, event, messageId, { type: 'sticker', key: media.fileKey });
}

async function sendPassiveMediaReverse(bot: FeishuBot, event: any, messageId: string, parsedMessage: ParsedFeishuMessage) {
  const chatId = messageChatId(event?.message);
  if (!chatId && !messageId) return;

  const media = await resolvePassiveMediaResource(bot, messageId, chatId || 'unknown_chat', parsedMessage);
  if (!media) return;
  const transformed = await buildMirroredImage(media, chatId || 'unknown_chat');
  try {
    const uploadedImageKey = await uploadImage(bot, transformed.data, transformed.fileName);
    await sendPassiveMedia(bot, event, messageId, { type: 'image', key: uploadedImageKey });
  } finally {
    await fs.unlink(transformed.filePath).catch(() => undefined);
  }
}

export async function runPassiveInteractions(bot: FeishuBot, event: any, messageId: string, parsedMessage: ParsedFeishuMessage, history: RecentChatMessage[]) {
  const config = passiveInteractionConfig();
  const tasks: Array<Promise<void>> = [];
  const chatId = messageChatId(event?.message);
  const mentionsBot = messageMentionsBot(bot, event?.message);
  const text = parsedMessage.text;
  const repeatText = parsedMessage.textForRepeat || text;
  const imitateText = parsedMessage.textForRepeat || text;
  const reactionSetting = getPassiveFeatureSetting(bot.id, chatId, 'reaction', config.reactionRate);
  const repeatSetting = getPassiveFeatureSetting(bot.id, chatId, 'repeat', config.repeatRate);
  const llmReplySetting = getPassiveFeatureSetting(bot.id, chatId, 'llm_reply', config.imitateRate);
  const mediaRepeatSetting = getPassiveFeatureSetting(bot.id, chatId, 'media_repeat', config.imageRepeatRate);
  const imageReverseSetting = getPassiveFeatureSetting(bot.id, chatId, 'image_reverse', config.imageReverseImageRate);
  const stickerReverseSetting = getPassiveFeatureSetting(bot.id, chatId, 'sticker_reverse', config.imageReverseStickerRate);
  const reactionTriggered = config.reactionEmojis.length > 0 && reactionSetting.enabled && triggerDecision(reactionSetting.rate).triggered;
  const repeatEligible = Boolean(text) && text.length <= config.repeatMaxChars;
  const repeatTriggered = repeatEligible && repeatSetting.enabled && triggerDecision(repeatSetting.rate).triggered;
  const mediaRepeatEligible = Boolean(parsedMessage.imageKey || parsedMessage.stickerFileKey);
  const mediaRepeatTriggered = mediaRepeatEligible && mediaRepeatSetting.enabled && triggerDecision(mediaRepeatSetting.rate).triggered;
  const imageReverseTriggered = Boolean(parsedMessage.imageKey) && imageReverseSetting.enabled && triggerDecision(imageReverseSetting.rate).triggered;
  const stickerReverseTriggered = Boolean(parsedMessage.stickerFileKey) && stickerReverseSetting.enabled && triggerDecision(stickerReverseSetting.rate).triggered;
  const byteStyleSetting = getStyleStickerSetting(
    bot.id,
    chatId,
    'byte_style',
    config.byteStyleRate,
    config.styleStickerDefaultMaxChars,
    config.styleStickerMaxCharsLimit
  );
  const scaleNewHeightsSetting = getStyleStickerSetting(
    bot.id,
    chatId,
    'scale_new_heights',
    config.scaleNewHeightsRate,
    config.styleStickerDefaultMaxChars,
    config.styleStickerMaxCharsLimit
  );
  const byteStyleTriggered = Boolean(text) && byteStyleSetting.enabled && text.length <= byteStyleSetting.maxChars && triggerDecision(byteStyleSetting.rate).triggered;
  const scaleNewHeightsTriggered = Boolean(text) && scaleNewHeightsSetting.enabled && text.length <= scaleNewHeightsSetting.maxChars && triggerDecision(scaleNewHeightsSetting.rate).triggered;
  const imitateEligible = !mentionsBot && Boolean(text);
  const imitateTriggered = imitateEligible && llmReplySetting.enabled && triggerDecision(llmReplySetting.rate).triggered;

  if (reactionTriggered) {
    const emoji = randomItem(config.reactionEmojis);
    tasks.push(addReactionTask(bot, messageId, emoji));
  }

  if (mediaRepeatTriggered) {
    tasks.push(sendPassiveMediaRepeat(bot, event, messageId, parsedMessage));
  }

  if (imageReverseTriggered) {
    tasks.push(sendPassiveMediaReverse(bot, event, messageId, parsedMessage));
  }

  if (stickerReverseTriggered) {
    tasks.push(sendPassiveMediaReverse(bot, event, messageId, parsedMessage));
  }

  const repeatCandidate = repeatTriggered;
  const styleStickerCandidates: StyleStickerFeature[] = [];
  if (byteStyleTriggered) styleStickerCandidates.push('byte_style');
  if (scaleNewHeightsTriggered) styleStickerCandidates.push('scale_new_heights');
  const exclusiveTextCandidates: Array<'repeat' | StyleStickerFeature> = [];
  if (repeatCandidate) exclusiveTextCandidates.push('repeat');
  exclusiveTextCandidates.push(...styleStickerCandidates);
  if (text && exclusiveTextCandidates.length > 0) {
    const selectedFeature = exclusiveTextCandidates.length === 1
      ? exclusiveTextCandidates[0]
      : randomItem(exclusiveTextCandidates);
    if (selectedFeature === 'repeat') {
      tasks.push(sendPassiveText(bot, event, messageId, repeatText));
    } else {
      tasks.push(sendPassiveStyleSticker(bot, event, messageId, selectedFeature, text));
    }
  }

  if (imitateTriggered) {
    tasks.push((async () => {
      const reply = await generateImitationReply(bot, event, imitateText, history, config);
      if (!reply) return;
      console.log('[feishu] imitate reply', reply);
      await sendPassiveText(bot, event, messageId, reply);
    })());
  }

  const results = await Promise.allSettled(tasks);
  results.forEach((result) => {
    if (result.status === 'rejected') {
      console.error('[feishu] passive interaction failed', {
        botId: bot.id,
        messageId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      });
    }
  });
}

// Import addReaction from api.ts and wrap it
import { addReaction } from '../api.js';
async function addReactionTask(bot: FeishuBot, messageId: string, emoji: string): Promise<void> {
  await addReaction(bot, messageId, emoji);
}
