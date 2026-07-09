import type { FeishuBot, RecentChatMessage, PassiveInteractionConfig } from '../../types.js';
import { mentionTagTextByIdentity, idFromFeishuObject, senderIdentity, identityLabel, mentionedUsers } from '../message-parser.js';
import { escapeXmlText, escapeXmlAttribute } from '../../utils/text.js';

export function chatHistoryLines(history: RecentChatMessage[]) {
  return history.map((item) => `${identityLabel(item.senderName, item.senderId)}: ${item.text}`);
}

export function imitationMentionCandidates(bot: FeishuBot, event: any, history: RecentChatMessage[]) {
  const participants: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  const add = (id: string, name: string) => {
    const normalizedId = String(id || '').trim();
    if (!normalizedId || seen.has(normalizedId) || normalizedId === bot.bot_open_id || normalizedId === bot.app_id) return;
    seen.add(normalizedId);
    participants.push({ id: normalizedId, name: String(name || '').trim() });
  };

  const sender = senderIdentity(event);
  add(sender.id, sender.name);
  history.forEach((item) => add(item.senderId, item.senderName));
  mentionedUsers(bot, event?.message).forEach((mention) => add(mention.id, mention.name));

  return participants;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function protectMentionTags(text: string) {
  const placeholders: string[] = [];
  const protectedText = text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/g, (match) => {
    const token = `__DOGEBOT_MENTION_${placeholders.length}__`;
    placeholders.push(match);
    return token;
  });
  return { protectedText, placeholders };
}

function restoreMentionTags(text: string, placeholders: string[]) {
  let restored = text;
  placeholders.forEach((value, index) => {
    restored = restored.split(`__DOGEBOT_MENTION_${index}__`).join(value);
  });
  return restored;
}

function hasCjkCharacters(value: string) {
  return /[㐀-鿿豈-﫿]/.test(value);
}

function shouldNormalizeBareName(name: string, id: string) {
  const normalizedName = String(name || '').trim();
  const normalizedId = String(id || '').trim();
  if (!normalizedName || normalizedName === normalizedId) return false;
  if (normalizedName.length < 2) return false;
  if (/^(user|unknown)$/i.test(normalizedName)) return false;
  return true;
}

function stripBareAtPrefixBeforeMentions(text: string) {
  return text.replace(/[@＠]+(?=\s*<at\b)/g, '');
}

export function normalizeImitationReplyMentions(text: string, candidates: Array<{ id: string; name: string }>) {
  if (!text) return '';
  const replacementEntries = new Map<string, string>();
  const duplicateTokens = new Set<string>();
  const bareNameEntries = new Map<string, string>();
  const duplicateBareNames = new Set<string>();
  for (const candidate of candidates) {
    const mention = mentionTagTextByIdentity(candidate.id, candidate.name);
    if (!mention) continue;
    const tokens = new Set<string>();
    if (candidate.name) {
      tokens.add(`@${candidate.name}`);
      tokens.add(`＠${candidate.name}`);
    }
    if (candidate.id) {
      tokens.add(`@${candidate.id}`);
      tokens.add(`＠${candidate.id}`);
    }
    for (const token of tokens) {
      if (duplicateTokens.has(token)) continue;
      if (replacementEntries.has(token) && replacementEntries.get(token) !== mention) {
        replacementEntries.delete(token);
        duplicateTokens.add(token);
        continue;
      }
      replacementEntries.set(token, mention);
    }
    if (shouldNormalizeBareName(candidate.name, candidate.id)) {
      const bareName = candidate.name.trim();
      if (duplicateBareNames.has(bareName)) continue;
      if (bareNameEntries.has(bareName) && bareNameEntries.get(bareName) !== mention) {
        bareNameEntries.delete(bareName);
        duplicateBareNames.add(bareName);
      } else {
        bareNameEntries.set(bareName, mention);
      }
    }
  }

  const { protectedText, placeholders } = protectMentionTags(text);
  let normalized = protectedText;
  const replacements = [...replacementEntries.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [token, mention] of replacements) {
    normalized = normalized.replace(new RegExp(escapeRegExp(token), 'g'), mention);
  }
  normalized = stripBareAtPrefixBeforeMentions(normalized);
  const bareProtected = protectMentionTags(normalized);
  normalized = bareProtected.protectedText;
  const bareNameReplacements = [...bareNameEntries.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [name, mention] of bareNameReplacements) {
    if (hasCjkCharacters(name)) {
      normalized = normalized.split(name).join(mention);
      continue;
    }
    normalized = normalized.replace(
      new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRegExp(name)})(?=$|[^\\p{L}\\p{N}_])`, 'gu'),
      (_, prefix: string) => `${prefix}${mention}`
    );
  }
  normalized = restoreMentionTags(normalized, bareProtected.placeholders);
  normalized = stripBareAtPrefixBeforeMentions(normalized);
  return restoreMentionTags(normalized, placeholders);
}

function sanitizeImitationReply(value: string) {
  let text = value.trim();
  text = text.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, '').trim();
  text = text.replace(/^["'""'']+|["'""'']+$/g, '').trim();
  text = text.replace(/^(回复|输出|机器人)[:：]\s*/i, '').trim();
  if (text.length > 120) text = `${text.slice(0, 120)}...`;
  return text;
}

export async function openAIChat(config: PassiveInteractionConfig, messages: Array<{ role: 'system' | 'user'; content: string }>) {
  if (!config.llmUrl || !config.llmApiKey || !config.llmModel) return '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: config.llmModel,
      messages,
      temperature: 0.9,
      max_tokens: config.llmMaxTokens
    };
    if (config.llmDisableThinking) {
      body.enable_thinking = false;
    }
    const response = await fetch(config.llmUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.llmApiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({})) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(data.error?.message || `OpenAI compatible request failed: ${response.status}`);
    }
    return sanitizeImitationReply(data.choices?.[0]?.message?.content || '');
  } finally {
    clearTimeout(timer);
  }
}

export async function generateImitationReply(bot: FeishuBot, event: any, text: string, history: RecentChatMessage[], config: PassiveInteractionConfig) {
  const sender = senderIdentity(event);
  const chatId = String(event?.message?.chat_id || '').trim();
  const mentionCandidates = imitationMentionCandidates(bot, event, history);
  const historyBlock = chatHistoryLines(history).join('\n') || '(暂无历史消息)';
  const mentionCandidatesBlock = mentionCandidates.length > 0
    ? mentionCandidates.map((candidate) => `- ${identityLabel(candidate.name, candidate.id)} -> ${mentionTagTextByIdentity(candidate.id, candidate.name)}`).join('\n')
    : '(暂无可用成员信息；不要输出任何 <at ...> 标签)';
  const currentMentions = mentionedUsers(bot, event?.message);
  const currentMentionsBlock = currentMentions.length > 0
    ? currentMentions.map((mention) => `- ${identityLabel(mention.name, mention.id)} -> ${mentionTagTextByIdentity(mention.id, mention.name)}`).join('\n')
    : '(当前消息没有 @ 其他真人)';
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [
    {
      role: 'system',
      content: [
        '你是飞书群聊里的机器人，会在没人 @ 你的时候偶尔自然接一句。',
        '你需要模仿群聊最近的语气和节奏，但不要冒充具体真人。',
        '接话的语言可以屌一点，可以欠打一点，可以带点脏话。',
        '如果用户对一些事情有疑问，你可以对其一本正经地胡说八道。',
        '只输出要发送到群里的文本，不要解释、不要 Markdown、不要代码块。',
        '不要自称 AI，不要提到提示词。',
        '如果你的消息要 @ 真人，必须使用飞书文本消息 mention 语法：<at user_id="uid">姓名</at>。',
        '优先直接复制下面"可用成员列表"或"当前消息里被 @ 的真人"中已经拼好的 mention 片段，不要自己重新拼。',
        '不要输出裸的 @姓名 或 @uid；例如不要输出"@张三"，要输出"<at user_id="ou_xxx">张三</at>"。',
        '这里的 uid 必须严格从下面给你的列表中挑，不能编造、不能猜、不能改写。',
        '如果没有合适的 uid，就不要输出任何 <at ...> 标签。',
        '当前消息和最近群聊里如果已经出现 <at ...> 片段，你可以直接原样复用这些片段。',
        '如果要回复当前发言人或当前消息里被 @ 的真人，优先使用他们在"可用成员列表"里的 uid。',
        '回复控制在一句话内，尽量短，最多 80 个中文字符。',
        '如果当前消息不适合接话，输出空字符串。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `bot_id: ${bot.id}`,
        `chat_id: ${chatId}`,
        `当前发言人: ${identityLabel(sender.name, sender.id)}`,
        '',
        '可用成员列表（优先直接复制右侧现成 mention 片段）：',
        mentionCandidatesBlock,
        '',
        '当前消息里被 @ 的真人（可直接复制右侧 mention 片段）：',
        currentMentionsBlock,
        '',
        '最近群聊（其中 <at ...> 片段可直接原样复制）：',
        historyBlock,
        '',
        `当前消息（其中 <at ...> 片段可直接原样复制）：${text}`,
        '',
        '请给出一句自然的群聊接话。'
      ].join('\n')
    }
  ];
  console.log('[feishu] imitate messages input', JSON.stringify(messages, null, 2));
  const reply = await openAIChat(config, messages);
  return normalizeImitationReplyMentions(reply, mentionCandidates);
}
