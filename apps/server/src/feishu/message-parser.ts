import type { FeishuBot, FeishuMention, ParsedFeishuMessage } from '../types.js';
import { escapeXmlText, escapeXmlAttribute } from '../utils/text.js';

export function idFromFeishuObject(value: any): string {
  if (typeof value === 'string') return value.trim();
  return String(value?.open_id || value?.user_id || value?.union_id || '').trim();
}

function safeParseMessageContent(message: any) {
  try {
    return JSON.parse(message?.content || '{}') as Record<string, any>;
  } catch {
    return {};
  }
}

function extractPostTextAndImage(content: Record<string, any>) {
  const textParts: string[] = [];
  let imageKey = '';
  const pushText = (value: unknown) => {
    const text = String(value || '').trim();
    if (text) textParts.push(text);
  };

  pushText(content.title);
  const paragraphs = Array.isArray(content.content) ? content.content : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    for (const block of paragraph) {
      if (!block || typeof block !== 'object') continue;
      const tag = String((block as Record<string, unknown>).tag || '').trim();
      if (!imageKey && tag === 'img') {
        imageKey = String((block as Record<string, unknown>).image_key || '').trim();
      }
      if (tag === 'text' || tag === 'a' || tag === 'md') {
        pushText((block as Record<string, unknown>).text);
      }
      if (tag === 'at') {
        pushText((block as Record<string, unknown>).user_name);
      }
    }
  }

  return {
    text: textParts.join(' ').replace(/\s+/g, ' ').trim(),
    imageKey
  };
}

export function mentionDisplayText(mention: FeishuMention) {
  const name = String(mention.name || '').trim();
  if (name) return `@${name}`;
  const id = idFromFeishuObject(mention.id);
  return id ? `@${id}` : '';
}

export function mentionTagTextByIdentity(id: string, name: string) {
  const normalizedId = String(id || '').trim();
  const normalizedName = String(name || '').trim();
  if (!normalizedId) return normalizedName ? `@${normalizedName}` : '';
  if (normalizedId === 'all') return '<at user_id="all"></at>';
  return `<at user_id="${escapeXmlAttribute(normalizedId)}">${escapeXmlText(normalizedName || normalizedId)}</at>`;
}

export function mentionTagText(mention: FeishuMention) {
  const id = idFromFeishuObject(mention.id);
  if (!id) return mentionDisplayText(mention);
  const name = String(mention.name || '').trim();
  return mentionTagTextByIdentity(id, name);
}

function replaceTextMentionPlaceholders(text: string, mentions: unknown) {
  const rawText = String(text || '');
  if (!rawText) return '';
  const mentionList = (Array.isArray(mentions) ? mentions : []) as FeishuMention[];
  if (mentionList.length === 0) return rawText.trim();

  let resolved = rawText;
  for (const mention of mentionList) {
    const key = String(mention.key || '').trim();
    const replacement = mentionDisplayText(mention);
    if (!key || !replacement) continue;
    resolved = resolved.split(key).join(replacement);
  }
  return resolved.trim();
}

function replaceTextMentionPlaceholdersForRepeat(text: string, mentions: unknown) {
  const rawText = String(text || '');
  if (!rawText) return '';
  const mentionList = (Array.isArray(mentions) ? mentions : []) as FeishuMention[];
  if (mentionList.length === 0) return rawText.trim();

  let resolved = rawText;
  for (const mention of mentionList) {
    const key = String(mention.key || '').trim();
    const replacement = mentionTagText(mention);
    if (!key || !replacement) continue;
    resolved = resolved.split(key).join(replacement);
  }
  return resolved.trim();
}

export function parseFeishuMessage(message: any): ParsedFeishuMessage {
  const messageType = String(message?.message_type || '').trim();
  const content = safeParseMessageContent(message);
  if (messageType === 'text') {
    return {
      messageType,
      text: replaceTextMentionPlaceholders(content.text, message?.mentions),
      textForRepeat: replaceTextMentionPlaceholdersForRepeat(content.text, message?.mentions),
      imageKey: '',
      stickerFileKey: ''
    };
  }
  if (messageType === 'image') {
    return {
      messageType,
      text: '',
      textForRepeat: '',
      imageKey: String(content.image_key || '').trim(),
      stickerFileKey: ''
    };
  }
  if (messageType === 'sticker') {
    return {
      messageType,
      text: '',
      textForRepeat: '',
      imageKey: '',
      stickerFileKey: String(content.file_key || '').trim()
    };
  }
  if (messageType === 'post') {
    const post = extractPostTextAndImage(content);
    return {
      messageType,
      text: post.text,
      textForRepeat: post.text,
      imageKey: post.imageKey,
      stickerFileKey: ''
    };
  }
  return {
    messageType,
    text: '',
    textForRepeat: '',
    imageKey: '',
    stickerFileKey: ''
  };
}

export function textFromMessage(message: any) {
  return parseFeishuMessage(message).text;
}

export function previewTextFromMessage(message: any) {
  const parsed = parseFeishuMessage(message);
  if (parsed.text) return parsed.text.slice(0, 50);
  if (parsed.imageKey) return '[图片]';
  if (parsed.stickerFileKey) return '[表情包]';
  return parsed.messageType ? `[${parsed.messageType}]` : '';
}

export function messageChatId(message: any) {
  return String(message?.chat_id || '').trim();
}

export function messageThreadId(message: any) {
  return String(message?.thread_id || '').trim();
}

export function isThreadMessage(message: any) {
  return Boolean(messageThreadId(message));
}

export function senderIdentity(event: any) {
  const sender = event?.sender || {};
  const senderName = String(
    sender.sender_name ||
    sender.name ||
    sender.display_name ||
    sender.nickname ||
    sender.sender_id?.name ||
    ''
  ).trim();
  return {
    id: idFromFeishuObject(sender.sender_id) || 'unknown',
    name: senderName || String(sender.sender_type || '').trim() || 'unknown'
  };
}

export function messageMentionsBot(bot: FeishuBot, message: any) {
  if (!bot.bot_open_id) return false;
  const mentions = (Array.isArray(message?.mentions) ? message.mentions : []) as FeishuMention[];
  return mentions.some((mention) => idFromFeishuObject(mention.id) === bot.bot_open_id);
}

export function isFromCurrentBot(bot: FeishuBot, event: any) {
  const senderType = String(event?.sender?.sender_type || '').trim().toLowerCase();
  if (senderType && senderType !== 'user') return true;
  const senderId = idFromFeishuObject(event?.sender?.sender_id);
  return Boolean(senderId && (senderId === bot.bot_open_id || senderId === bot.app_id));
}

export function mentionedUsers(bot: FeishuBot, message: any) {
  const seen = new Set<string>();
  const mentions = (Array.isArray(message?.mentions) ? message.mentions : []) as FeishuMention[];
  return mentions.flatMap((mention) => {
    const id = idFromFeishuObject(mention.id);
    if (!id) return [];
    if (id === bot.bot_open_id) return [];
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, name: mention.name || '' }];
  });
}

export function referencedMessageIds(message: any) {
  return [...new Set([
    String(message?.parent_id || '').trim(),
    String(message?.root_id || '').trim()
  ].filter(Boolean))];
}

export function debugFeishu(label: string, payload: unknown) {
  if (process.env.DOGEBOT_FEISHU_DEBUG !== '1') return;
  try {
    console.log(`[feishu:debug] ${label}`, JSON.stringify(payload, null, 2));
  } catch {
    console.log(`[feishu:debug] ${label}`, payload);
  }
}

export function identityLabel(name: string, id: string) {
  const normalizedName = String(name || '').trim();
  const normalizedId = String(id || '').trim();
  if (normalizedName && normalizedId && normalizedName !== normalizedId) {
    return `${normalizedName}（${normalizedId}）`;
  }
  return normalizedName || normalizedId || 'unknown';
}

export function isManualReverseCommand(text: string) {
  if (!text.trim()) return false;
  return /(?:^|[\s,.;!?，。！？、])\/?reverse(?=$|[\s,.;!?，。！？、])/i.test(text) || text.includes('反转');
}
