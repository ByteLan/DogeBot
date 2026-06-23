import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { db } from './db.js';
import { randomDouyinAwemeIds, softDeleteDouyinAwemeRecords } from './douyin.js';

const FEISHU_BASE: Record<string, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com'
};

export type FeishuBot = {
  id: number;
  user_id: number | null;
  name: string;
  app_id: string;
  app_secret: string;
  domain: string;
  verification_token: string;
  encrypt_key: string;
  bot_name: string | null;
  bot_open_id: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type TokenCacheEntry = { token: string; expiresAt: number };
const tokenCache = new Map<number, TokenCacheEntry>();

type FeishuMention = {
  key?: string;
  name?: string;
  id?: string | {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  id_type?: string;
  tenant_key?: string;
};

type AtRecord = {
  at_who: string;
  at_who_name: string;
};

type UsersCommand = {
  isUsers: boolean;
  shouldDelete: boolean;
  shouldTop: boolean;
  newCount?: number;
};

type DouyinCommand = {
  isDouyin: boolean;
  clickText: string;
  count: number;
  shouldDelete: boolean;
  deleteAwemeId: string;
  hasInvalidCount: boolean;
  hasInvalidDelete: boolean;
};

type SetDefaultCommand = {
  isSetDefault: boolean;
  defaultCommand: string;
};

type DefaultCommandRecord = {
  defaultCommand: string;
  adminUserId: string;
};

type SetDefaultCommandResult =
  | { ok: true; assignedAdmin: boolean }
  | { ok: false; adminUserId: string };

type AddCronCommand = {
  isAddCron: boolean;
  cronExpr: string;
  commandText: string;
};

type ChatCronTask = {
  id: number;
  bot_id: number;
  chat_id: string;
  cron_expr: string;
  command_text: string;
  next_run_at: string;
};

type CronField = {
  values: Set<number>;
  unrestricted: boolean;
};

type PassiveInteractionConfig = {
  reactionRate: number;
  repeatRate: number;
  imitateRate: number;
  repeatMaxChars: number;
  contextSize: number;
  reactionEmojis: string[];
  llmUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  llmMaxTokens: number;
};

type RecentChatMessage = {
  senderId: string;
  senderName: string;
  text: string;
  createdAt: number;
};

let cronSchedulerTimer: NodeJS.Timeout | undefined;
let cronSchedulerRunning = false;
const FEISHU_EVENT_DEDUP_TTL_MS = 10 * 60 * 1000;
const recentFeishuEventKeys = new Map<string, number>();
const USERS_CARD_PERSON_LIST_CHUNK_SIZE = 100;
const RECENT_CHAT_MEMORY_LIMIT = 30;
const DEFAULT_REACTION_EMOJIS = ['OK', 'DONE', 'THUMBSUP', 'HEART', 'LAUGH'];
const recentChatMessages = new Map<string, RecentChatMessage[]>();

function cleanupRecentFeishuEventKeys(now: number) {
  for (const [eventKey, expiresAt] of recentFeishuEventKeys) {
    if (expiresAt <= now) recentFeishuEventKeys.delete(eventKey);
  }
}

function rememberFeishuEventKey(eventKey: string) {
  const now = Date.now();
  cleanupRecentFeishuEventKeys(now);
  if (recentFeishuEventKeys.has(eventKey)) return false;
  recentFeishuEventKeys.set(eventKey, now + FEISHU_EVENT_DEDUP_TTL_MS);
  return true;
}

function openBase(domain: string) {
  return FEISHU_BASE[domain] || FEISHU_BASE.feishu;
}

async function feishuSdkClient(bot: FeishuBot) {
  const lark = await import('@larksuiteoapi/node-sdk');
  return new lark.Client({
    appId: bot.app_id,
    appSecret: bot.app_secret,
    domain: bot.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.warn,
    source: 'dogebot'
  });
}

export function publicBot(row: FeishuBot) {
  return {
    id: row.id,
    name: row.name,
    appId: row.app_id,
    domain: row.domain,
    hasVerificationToken: Boolean(row.verification_token),
    hasEncryptKey: Boolean(row.encrypt_key),
    botName: row.bot_name,
    botOpenId: row.bot_open_id,
    enabled: Boolean(row.enabled),
    webhookPath: `/feishu/webhook/${row.id}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getBot(id: number) {
  return db.prepare('SELECT * FROM feishu_bots WHERE id = ?').get(id) as FeishuBot | undefined;
}

export function getEnabledBots() {
  return db.prepare('SELECT * FROM feishu_bots WHERE enabled = 1 AND user_id IS NOT NULL ORDER BY id ASC').all() as FeishuBot[];
}

async function feishuJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => ({}))) as T & { code?: number; msg?: string };
  if (!response.ok || (typeof data.code === 'number' && data.code !== 0)) {
    throw new Error(data.msg || `Feishu request failed: ${response.status}`);
  }
  return data;
}

async function tenantAccessToken(bot: FeishuBot) {
  const cached = tokenCache.get(bot.id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const data = await feishuJson<{ tenant_access_token: string; expire: number }>(`${openBase(bot.domain)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: bot.app_id, app_secret: bot.app_secret })
  });
  tokenCache.set(bot.id, { token: data.tenant_access_token, expiresAt: Date.now() + Math.max(60, data.expire - 60) * 1000 });
  return data.tenant_access_token;
}

export async function probeBot(bot: FeishuBot) {
  const token = await tenantAccessToken(bot);
  const data = await feishuJson<{ bot?: { name?: string; app_name?: string; bot_name?: string; open_id?: string }; data?: { bot?: { name?: string; app_name?: string; bot_name?: string; open_id?: string } } }>(`${openBase(bot.domain)}/open-apis/bot/v3/info`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` }
  });
  const info = data.bot || data.data?.bot || {};
  const botName = info.name || info.app_name || info.bot_name || null;
  const botOpenId = info.open_id || null;
  db.prepare('UPDATE feishu_bots SET bot_name = ?, bot_open_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(botName, botOpenId, bot.id);
  return { botName, botOpenId };
}

export function textFromMessage(message: any) {
  if (message?.message_type !== 'text') return '';
  try {
    const content = JSON.parse(message.content || '{}') as { text?: string };
    return (content.text || '').trim();
  } catch {
    return '';
  }
}

export async function replyText(bot: FeishuBot, messageId: string, text: string) {
  const token = await tenantAccessToken(bot);
  console.log('[feishu] text reply send start', { botId: bot.id, messageId, textLength: text.length });
  try {
    await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) })
    });
    console.log('[feishu] text reply send success', { botId: bot.id, messageId, textLength: text.length });
  } catch (error) {
    console.error('[feishu] text reply send failed', {
      botId: bot.id,
      messageId,
      textLength: text.length,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function sendTextToChat(bot: FeishuBot, chatId: string, text: string) {
  const token = await tenantAccessToken(bot);
  console.log('[feishu] chat text send start', { botId: bot.id, chatId, textLength: text.length });
  try {
    await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) })
    });
    console.log('[feishu] chat text send success', { botId: bot.id, chatId, textLength: text.length });
  } catch (error) {
    console.error('[feishu] chat text send failed', {
      botId: bot.id,
      chatId,
      textLength: text.length,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function addReaction(bot: FeishuBot, messageId: string, reactionType: string) {
  const token = await tenantAccessToken(bot);
  console.log('[feishu] reaction send start', { botId: bot.id, messageId, reactionType });
  try {
    await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reaction_type: { emoji_type: reactionType } })
    });
    console.log('[feishu] reaction send success', { botId: bot.id, messageId, reactionType });
  } catch (error) {
    console.error('[feishu] reaction send failed', {
      botId: bot.id,
      messageId,
      reactionType,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function replyCard(bot: FeishuBot, messageId: string, card: object) {
  const token = await tenantAccessToken(bot);
  await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) })
  });
}

function debugFeishu(label: string, payload: unknown) {
  if (process.env.DOGEBOT_FEISHU_DEBUG === '0') return;
  try {
    console.log(`[feishu:debug] ${label}`, JSON.stringify(payload, null, 2));
  } catch {
    console.log(`[feishu:debug] ${label}`, payload);
  }
}

function idFromFeishuObject(value: any): string {
  if (typeof value === 'string') return value.trim();
  return String(value?.open_id || value?.user_id || value?.union_id || '').trim();
}

function senderIdentity(event: any) {
  const sender = event?.sender || {};
  return {
    id: idFromFeishuObject(sender.sender_id) || 'unknown',
    name: String(sender.sender_type || '')
  };
}

function envString(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function parseRate(raw: string | undefined, fallback: number) {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const normalized = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, normalized));
}

function parsePositiveInt(raw: string | undefined, fallback: number) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function splitCsv(raw: string | undefined, fallback: string[]) {
  const items = (raw || '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function openAIChatCompletionsUrl(url: string) {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function passiveInteractionConfig(): PassiveInteractionConfig {
  return {
    reactionRate: parseRate(process.env.DOGEBOT_FEISHU_REACTION_RATE, 0.1),
    repeatRate: parseRate(process.env.DOGEBOT_FEISHU_REPEAT_RATE, 0.05),
    imitateRate: parseRate(process.env.DOGEBOT_FEISHU_IMITATE_RATE, 0.05),
    repeatMaxChars: parsePositiveInt(process.env.DOGEBOT_FEISHU_REPEAT_MAX_CHARS, 300),
    contextSize: parsePositiveInt(process.env.DOGEBOT_FEISHU_IMITATE_CONTEXT_SIZE, 8),
    reactionEmojis: splitCsv(process.env.DOGEBOT_FEISHU_REACTION_EMOJIS, DEFAULT_REACTION_EMOJIS),
    llmUrl: openAIChatCompletionsUrl(envString('DOGEBOT_LLM_URL', 'DOGEBOT_LLM_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE')),
    llmApiKey: envString('DOGEBOT_LLM_API_KEY', 'OPENAI_API_KEY'),
    llmModel: envString('DOGEBOT_LLM_MODEL', 'OPENAI_MODEL'),
    llmTimeoutMs: parsePositiveInt(envString('DOGEBOT_LLM_TIMEOUT_MS', 'OPENAI_TIMEOUT_MS'), 15_000),
    llmMaxTokens: parsePositiveInt(process.env.DOGEBOT_LLM_MAX_TOKENS, 160)
  };
}

function triggerDecision(rate: number) {
  const roll = Math.random();
  return { roll, triggered: rate > 0 && roll < rate };
}

function randomItem<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function messageChatId(message: any) {
  return String(message?.chat_id || '').trim();
}

function recentChatKey(botId: number, chatId: string) {
  return `${botId}:${chatId}`;
}

function readRecentChatMessages(botId: number, chatId: string, limit: number) {
  const list = recentChatMessages.get(recentChatKey(botId, chatId)) || [];
  return list.slice(-limit);
}

function rememberRecentChatMessage(bot: FeishuBot, event: any, text: string) {
  const chatId = messageChatId(event?.message);
  if (!chatId || !text) return;
  const sender = senderIdentity(event);
  const key = recentChatKey(bot.id, chatId);
  const list = recentChatMessages.get(key) || [];
  list.push({
    senderId: sender.id,
    senderName: sender.name,
    text,
    createdAt: Date.now()
  });
  recentChatMessages.set(key, list.slice(-RECENT_CHAT_MEMORY_LIMIT));
}

function messageMentionsBot(bot: FeishuBot, message: any) {
  if (!bot.bot_open_id) return false;
  const mentions = (Array.isArray(message?.mentions) ? message.mentions : []) as FeishuMention[];
  return mentions.some((mention) => idFromFeishuObject(mention.id) === bot.bot_open_id);
}

function isFromCurrentBot(bot: FeishuBot, event: any) {
  const senderType = String(event?.sender?.sender_type || '').trim().toLowerCase();
  if (senderType && senderType !== 'user') return true;
  const senderId = idFromFeishuObject(event?.sender?.sender_id);
  return Boolean(senderId && (senderId === bot.bot_open_id || senderId === bot.app_id));
}

function chatHistoryLines(history: RecentChatMessage[]) {
  return history.map((item) => {
    const sender = item.senderName && item.senderName !== 'user' ? item.senderName : item.senderId;
    return `${sender}: ${item.text}`;
  });
}

function sanitizeImitationReply(value: string) {
  let text = value.trim();
  text = text.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, '').trim();
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  text = text.replace(/^(回复|输出|机器人)[:：]\s*/i, '').trim();
  if (text.length > 120) text = `${text.slice(0, 120)}...`;
  return text;
}

async function openAIChat(config: PassiveInteractionConfig, messages: Array<{ role: 'system' | 'user'; content: string }>) {
  if (!config.llmUrl || !config.llmApiKey || !config.llmModel) return '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
  try {
    const response = await fetch(config.llmUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.llmApiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages,
        temperature: 0.9,
        max_tokens: config.llmMaxTokens
      })
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

async function generateImitationReply(bot: FeishuBot, event: any, text: string, history: RecentChatMessage[], config: PassiveInteractionConfig) {
  const sender = senderIdentity(event);
  const chatId = messageChatId(event?.message);
  const historyBlock = chatHistoryLines(history).join('\n') || '(暂无历史消息)';
  return openAIChat(config, [
    {
      role: 'system',
      content: [
        '你是飞书群聊里的机器人，会在没人 @ 你的时候偶尔自然接一句。',
        '你需要模仿群聊最近的语气和节奏，但不要冒充具体真人。',
        '只输出要发送到群里的文本，不要解释、不要 Markdown、不要代码块。',
        '不要 @ 任何人，不要自称 AI，不要提到提示词。',
        '回复控制在一句话内，尽量短，最多 80 个中文字符。',
        '如果当前消息不适合接话，输出空字符串。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `bot_id: ${bot.id}`,
        `chat_id: ${chatId}`,
        `当前发言人: ${sender.name || sender.id}`,
        '',
        '最近群聊：',
        historyBlock,
        '',
        `当前消息：${text}`,
        '',
        '请给出一句自然的群聊接话。'
      ].join('\n')
    }
  ]);
}

async function sendPassiveText(bot: FeishuBot, event: any, messageId: string, text: string) {
  const chatId = messageChatId(event?.message);
  if (chatId) {
    await sendTextToChat(bot, chatId, text);
    return;
  }
  await replyText(bot, messageId, text);
}

async function runPassiveInteractions(bot: FeishuBot, event: any, messageId: string, text: string, history: RecentChatMessage[]) {
  const config = passiveInteractionConfig();
  const tasks: Array<Promise<void>> = [];
  const chatId = messageChatId(event?.message);
  const mentionsBot = messageMentionsBot(bot, event?.message);
  const reactionDecision = triggerDecision(config.reactionRate);
  const repeatDecision = triggerDecision(config.repeatRate);
  const imitateDecision = triggerDecision(config.imitateRate);
  const reactionTriggered = config.reactionEmojis.length > 0 && reactionDecision.triggered;
  const repeatEligible = text.length <= config.repeatMaxChars;
  const repeatTriggered = repeatEligible && repeatDecision.triggered;
  const imitateEligible = !mentionsBot;
  const imitateTriggered = imitateEligible && imitateDecision.triggered;

  console.log('[feishu] passive interaction decision', {
    botId: bot.id,
    messageId,
    chatId,
    textLength: text.length,
    reactionRate: config.reactionRate,
    reactionRoll: Number(reactionDecision.roll.toFixed(4)),
    reactionEmojiCount: config.reactionEmojis.length,
    reactionTriggered,
    repeatRate: config.repeatRate,
    repeatRoll: Number(repeatDecision.roll.toFixed(4)),
    repeatEligible,
    repeatTriggered,
    imitateRate: config.imitateRate,
    imitateRoll: Number(imitateDecision.roll.toFixed(4)),
    imitateEligible,
    imitateTriggered
  });

  if (reactionTriggered) {
    const emoji = randomItem(config.reactionEmojis);
    console.log('[feishu] passive reaction scheduled', { botId: bot.id, messageId, reactionType: emoji });
    tasks.push(addReaction(bot, messageId, emoji));
  }

  if (repeatTriggered) {
    console.log('[feishu] passive repeat scheduled', { botId: bot.id, messageId, chatId, textLength: text.length });
    tasks.push(sendPassiveText(bot, event, messageId, text));
  }

  if (imitateTriggered) {
    tasks.push((async () => {
      const reply = await generateImitationReply(bot, event, text, history, config);
      if (!reply) {
        console.log('[feishu] passive imitate empty reply skipped', { botId: bot.id, messageId, chatId });
        return;
      }
      console.log('[feishu] passive imitate reply scheduled', { botId: bot.id, messageId, chatId, textLength: reply.length });
      await sendPassiveText(bot, event, messageId, reply);
    })());
  }

  const results = await Promise.allSettled(tasks);
  console.log('[feishu] passive interaction finished', {
    botId: bot.id,
    messageId,
    chatId,
    tasks: results.length,
    fulfilled: results.filter((result) => result.status === 'fulfilled').length,
    rejected: results.filter((result) => result.status === 'rejected').length
  });
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

function parseUsersCommand(text: string): UsersCommand {
  const commandIndex = text.indexOf('/users');
  if (commandIndex < 0) return { isUsers: false, shouldDelete: false, shouldTop: false };

  const args = text.slice(commandIndex + '/users'.length).trim().split(/\s+/).filter(Boolean);
  const newIndex = args.indexOf('new');
  const parsedNewCount = newIndex >= 0 ? Number(args[newIndex + 1]) : undefined;
  return {
    isUsers: true,
    shouldDelete: args.includes('delete'),
    shouldTop: args.includes('top'),
    newCount: parsedNewCount && parsedNewCount > 0 ? Math.floor(parsedNewCount) : undefined
  };
}

function parseDouyinCommand(text: string): DouyinCommand {
  const commandIndex = text.indexOf('/douyin');
  if (commandIndex < 0) {
    return {
      isDouyin: false,
      clickText: '',
      count: 1,
      shouldDelete: false,
      deleteAwemeId: '',
      hasInvalidCount: false,
      hasInvalidDelete: false
    };
  }
  const argsText = text.slice(commandIndex + '/douyin'.length).trim();
  const hasDeleteFlag = /(?:^|\s)--delete(?:\s|$)/.test(argsText);
  const deleteMatch = argsText.match(/(?:^|\s)--delete\s+(\S+)/);
  const deleteAwemeId = deleteMatch?.[1] || '';
  const hasInvalidDelete = hasDeleteFlag && !/^\d{6,}$/.test(deleteAwemeId);
  const hasCountFlag = /(?:^|\s)--count(?:\s|$)/.test(argsText);
  const countMatch = argsText.match(/(?:^|\s)--count\s+(\S+)/);
  const clickText = argsText
    .replace(/(?:^|\s)--delete(?:\s+\S+)?/, ' ')
    .replace(/(?:^|\s)--count(?:\s+\S+)?/, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!hasCountFlag) {
    return {
      isDouyin: true,
      clickText: hasDeleteFlag ? clickText : argsText,
      count: 1,
      shouldDelete: hasDeleteFlag,
      deleteAwemeId,
      hasInvalidCount: false,
      hasInvalidDelete
    };
  }
  if (!countMatch) {
    return {
      isDouyin: true,
      clickText,
      count: 1,
      shouldDelete: hasDeleteFlag,
      deleteAwemeId,
      hasInvalidCount: true,
      hasInvalidDelete
    };
  }
  const count = Number(countMatch[1]);
  return {
    isDouyin: true,
    clickText,
    count: Number.isInteger(count) && count > 0 ? count : 1,
    shouldDelete: hasDeleteFlag,
    deleteAwemeId,
    hasInvalidCount: !Number.isInteger(count) || count <= 0,
    hasInvalidDelete
  };
}

async function sendDouyinMessages(bot: FeishuBot, clickText: string, count: number, sendMessage: (text: string) => Promise<void>) {
  const awemeRecords = randomDouyinAwemeIds(bot.user_id!, clickText, count);
  console.log('[feishu] douyin send start', {
    botId: bot.id,
    userId: bot.user_id,
    clickText,
    requestedCount: count,
    actualCount: awemeRecords.length,
    awemeIds: awemeRecords.map((record) => record.aweme_id)
  });
  if (awemeRecords.length === 0) {
    await sendMessage(`暂无“${clickText}”的抖音收藏记录`);
    return;
  }
  for (const [index, record] of awemeRecords.entries()) {
    try {
      await sendMessage(`https://www.douyin.com/video/${record.aweme_id}`);
    } catch (error) {
      console.error('[feishu] douyin send failed', {
        botId: bot.id,
        userId: bot.user_id,
        clickText,
        awemeId: record.aweme_id,
        currentIndex: index + 1,
        totalCount: awemeRecords.length,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    if (index < awemeRecords.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function unquoteCommand(value: string) {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function parseSetDefaultCommand(text: string): SetDefaultCommand {
  const commandIndex = text.indexOf('/set-default');
  if (commandIndex < 0) return { isSetDefault: false, defaultCommand: '' };
  return {
    isSetDefault: true,
    defaultCommand: unquoteCommand(text.slice(commandIndex + '/set-default'.length))
  };
}

function readQuotedToken(value: string) {
  const text = value.trimStart();
  if (!text) return { token: '', rest: '' };
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    let escaped = false;
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        return {
          token: text.slice(1, index).replace(/\\(["'\\])/g, '$1').trim(),
          rest: text.slice(index + 1).trim()
        };
      }
    }
  }
  const [token = '', ...rest] = text.split(/\s+/);
  return { token, rest: rest.join(' ').trim() };
}

function parseAddCronCommand(text: string): AddCronCommand {
  const commandIndex = text.indexOf('/add-cron');
  if (commandIndex < 0) return { isAddCron: false, cronExpr: '', commandText: '' };
  const rest = text.slice(commandIndex + '/add-cron'.length).trim();
  if (!rest) return { isAddCron: true, cronExpr: '', commandText: '' };
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const cron = readQuotedToken(rest);
    return { isAddCron: true, cronExpr: cron.token, commandText: unquoteCommand(cron.rest) };
  }
  const parts = rest.split(/\s+/).filter(Boolean);
  return {
    isAddCron: true,
    cronExpr: parts.slice(0, 5).join(' '),
    commandText: unquoteCommand(parts.slice(5).join(' '))
  };
}

function parseCronField(raw: string, min: number, max: number): CronField {
  const values = new Set<number>();
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const unrestricted = parts.length === 1 && parts[0] === '*';
  for (const part of parts) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid cron step: ${part}`);
    let start = min;
    let end = max;
    if (rangePart.includes('-')) {
      const [from, to] = rangePart.split('-').map(Number);
      if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`invalid cron range: ${part}`);
      start = from;
      end = to;
    } else if (rangePart !== '*') {
      const value = Number(rangePart);
      if (!Number.isInteger(value)) throw new Error(`invalid cron value: ${part}`);
      start = value;
      end = value;
    }
    if (start < min || end > max || start > end) throw new Error(`cron value out of range: ${part}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`empty cron field: ${raw}`);
  return { values, unrestricted };
}

function nextCronRunAt(cronExpr: string, from = new Date()) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周');
  const [minute, hour, dayOfMonth, month, dayOfWeek] = [
    parseCronField(parts[0], 0, 59),
    parseCronField(parts[1], 0, 23),
    parseCronField(parts[2], 1, 31),
    parseCronField(parts[3], 1, 12),
    parseCronField(parts[4], 0, 7)
  ];
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const deadline = new Date(cursor.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (cursor <= deadline) {
    const dow = cursor.getDay();
    const dowMatches = dayOfWeek.values.has(dow) || (dow === 0 && dayOfWeek.values.has(7));
    const domMatches = dayOfMonth.values.has(cursor.getDate());
    const dayMatches = dayOfMonth.unrestricted || dayOfWeek.unrestricted ? domMatches && dowMatches : domMatches || dowMatches;
    if (
      minute.values.has(cursor.getMinutes()) &&
      hour.values.has(cursor.getHours()) &&
      month.values.has(cursor.getMonth() + 1) &&
      dayMatches
    ) {
      return cursor;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error('无法计算下一次执行时间');
}

function addCronTask(botId: number, chatId: string, cronExpr: string, commandText: string) {
  const nextRunAt = nextCronRunAt(cronExpr).toISOString();
  const result = db.prepare(`
    INSERT INTO feishu_chat_cron_tasks (bot_id, chat_id, cron_expr, command_text, next_run_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(botId, chatId, cronExpr, commandText, nextRunAt);
  return { id: Number(result.lastInsertRowid), nextRunAt };
}

function getDefaultCommandRecord(botId: number): DefaultCommandRecord | undefined {
  const row = db.prepare('SELECT default_command, admin_user_id FROM feishu_bot_default_commands WHERE bot_id = ?').get(botId) as
    | { default_command: string; admin_user_id: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    defaultCommand: row.default_command.trim(),
    adminUserId: row.admin_user_id?.trim() || ''
  };
}

function setDefaultCommand(botId: number, defaultCommand: string, adminUserId: string): SetDefaultCommandResult {
  const existing = getDefaultCommandRecord(botId);
  if (existing?.adminUserId && existing.adminUserId !== adminUserId) {
    return { ok: false, adminUserId: existing.adminUserId };
  }
  const assignedAdmin = !existing?.adminUserId;
  db.prepare(`
    INSERT INTO feishu_bot_default_commands (bot_id, default_command, admin_user_id)
    VALUES (?, ?, ?)
    ON CONFLICT(bot_id) DO UPDATE SET
      default_command = excluded.default_command,
      admin_user_id = CASE
        WHEN feishu_bot_default_commands.admin_user_id IS NULL OR feishu_bot_default_commands.admin_user_id = ''
        THEN excluded.admin_user_id
        ELSE feishu_bot_default_commands.admin_user_id
      END,
      updated_at = CURRENT_TIMESTAMP
  `).run(botId, defaultCommand, adminUserId);
  return { ok: true, assignedAdmin };
}

function getDefaultCommand(botId: number) {
  return getDefaultCommandRecord(botId)?.defaultCommand || '';
}

function mentionedUsers(bot: FeishuBot, message: any) {
  const seen = new Set<string>();
  const mentions = (Array.isArray(message?.mentions) ? message.mentions : []) as FeishuMention[];
  debugFeishu('mentions.raw', {
    botId: bot.id,
    botOpenId: bot.bot_open_id,
    messageId: message?.message_id,
    messageType: message?.message_type,
    content: message?.content,
    mentions: mentions.map((mention) => ({
      key: mention.key,
      name: mention.name,
      id: mention.id,
      idType: mention.id_type,
      tenantKey: mention.tenant_key
    }))
  });
  return mentions.flatMap((mention) => {
    const id = idFromFeishuObject(mention.id);
    if (!id) {
      debugFeishu('mentions.skip.empty-id', { key: mention.key, name: mention.name, rawId: mention.id });
      return [];
    }
    if (id === bot.bot_open_id) {
      debugFeishu('mentions.skip.bot-self', { key: mention.key, name: mention.name, id });
      return [];
    }
    if (seen.has(id)) {
      debugFeishu('mentions.skip.duplicate', { key: mention.key, name: mention.name, id });
      return [];
    }
    seen.add(id);
    debugFeishu('mentions.accept', { key: mention.key, name: mention.name, id, idType: mention.id_type });
    return [{ id, name: mention.name || '' }];
  });
}

function softDeleteMentions(botId: number, atBy: string, atWhos: string[]) {
  if (atWhos.length === 0) {
    db.prepare(`
      UPDATE at_users_record
      SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE bot_id = ? AND at_by = ? AND deleted_at IS NULL
    `).run(botId, atBy);
    return;
  }

  const stmt = db.prepare(`
    UPDATE at_users_record
    SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE bot_id = ? AND at_by = ? AND at_who = ? AND deleted_at IS NULL
  `);
  const tx = db.transaction((ids: string[]) => ids.forEach((id) => stmt.run(botId, atBy, id)));
  tx(atWhos);
}

function upsertMentions(botId: number, atBy: string, atByName: string, mentions: Array<{ id: string; name: string }>) {
  if (mentions.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO at_users_record (bot_id, at_by, at_by_name, at_who, at_who_name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bot_id, at_by, at_who) DO UPDATE SET
      at_by_name = excluded.at_by_name,
      at_who_name = excluded.at_who_name,
      deleted_at = NULL,
      created_at = CASE WHEN at_users_record.deleted_at IS NOT NULL THEN CURRENT_TIMESTAMP ELSE at_users_record.created_at END,
      updated_at = CURRENT_TIMESTAMP
  `);
  const tx = db.transaction((items: Array<{ id: string; name: string }>) => items.forEach((item) => stmt.run(botId, atBy, atByName, item.id, item.name)));
  tx(mentions);
}

function topMentions(botId: number, atBy: string, atWhos: string[]) {
  if (atWhos.length === 0) return;
  const maxSort = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM at_users_record WHERE bot_id = ? AND at_by = ?').get(botId, atBy) as { value: number }).value;
  const stmt = db.prepare(`
    UPDATE at_users_record
    SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE bot_id = ? AND at_by = ? AND at_who = ? AND deleted_at IS NULL
  `);
  const tx = db.transaction((ids: string[]) => ids.forEach((id, index) => stmt.run(maxSort + ids.length - index, botId, atBy, id)));
  tx(atWhos);
}

function listMentions(botId: number, atBy: string, newCount?: number) {
  const orderBy = newCount ? 'created_at DESC, id DESC' : 'sort_order DESC, created_at ASC, id ASC';
  const limit = newCount ? 'LIMIT ?' : '';
  return db.prepare(`
    SELECT at_who, at_who_name
    FROM at_users_record
    WHERE bot_id = ? AND at_by = ? AND deleted_at IS NULL
    ORDER BY ${orderBy}
    ${limit}
  `).all(...(newCount ? [botId, atBy, newCount] : [botId, atBy])) as AtRecord[];
}

function usersPersonListCard(records: AtRecord[]) {
  const firstChunk = records.slice(0, USERS_CARD_PERSON_LIST_CHUNK_SIZE);
  const elements: object[] = firstChunk.length > 0
    ? [usersPersonListElement(firstChunk, 0)]
    : [{ tag: 'markdown', content: '暂无已记录用户', element_id: 'users_empty' }];
  return {
    schema: '2.0',
    body: { elements }
  };
}

function usersMarkdownCard(records: AtRecord[]) {
  const firstChunk = records.slice(0, USERS_CARD_PERSON_LIST_CHUNK_SIZE);
  const elements: object[] = firstChunk.length > 0
    ? [usersMarkdownElement(firstChunk, 0)]
    : [{ tag: 'markdown', content: '暂无已记录用户', element_id: 'users_markdown_empty' }];
  return {
    schema: '2.0',
    body: { elements }
  };
}

function usersMarkdownElement(records: AtRecord[], index: number) {
  return {
    tag: 'markdown',
    element_id: `users_markdown_${index}`,
    content: records.map((record) => `<at id=${record.at_who}></at>`).join(' ')
  };
}

function usersPersonListElement(records: AtRecord[], index: number) {
  return {
    tag: 'person_list',
    element_id: `users_person_list_${index}`,
    drop_invalid_user_id: true,
    show_avatar: true,
    size: 'large',
    persons: records.map((record) => ({ id: record.at_who }))
  };
}

function usersDividerElement(index: number) {
  return {
    tag: 'hr',
    element_id: `users_divider_${index}`
  };
}

function chunkUsersRecords(records: AtRecord[]) {
  const chunks: AtRecord[][] = [];
  for (let index = 0; index < records.length; index += USERS_CARD_PERSON_LIST_CHUNK_SIZE) {
    chunks.push(records.slice(index, index + USERS_CARD_PERSON_LIST_CHUNK_SIZE));
  }
  return chunks;
}

async function createCardEntity(client: Awaited<ReturnType<typeof feishuSdkClient>>, card: object) {
  const createResult = await client.cardkit.v1.card.create({
    data: {
      type: 'card_json',
      data: JSON.stringify(card)
    }
  });
  const cardId = createResult.data?.card_id;
  if (!cardId) throw new Error('failed to create card entity');
  return cardId;
}

async function replyCardReference(client: Awaited<ReturnType<typeof feishuSdkClient>>, messageId: string, cardId: string, replyInThread = false) {
  return client.im.v1.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'interactive',
      content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      reply_in_thread: replyInThread
    }
  });
}

async function appendUsersCardElements(client: Awaited<ReturnType<typeof feishuSdkClient>>, cardId: string, chunks: AtRecord[][], buildElements: (chunk: AtRecord[], index: number) => object[]) {
  let sequence = 1;
  for (let index = 1; index < chunks.length; index += 1) {
    await client.cardkit.v1.cardElement.create({
      path: { card_id: cardId },
      data: {
        type: 'append',
        sequence,
        uuid: `users_${cardId}_${sequence}`,
        elements: JSON.stringify(buildElements(chunks[index], index))
      }
    });
    sequence += 1;
  }
}

async function replyUsersCard(bot: FeishuBot, messageId: string, records: AtRecord[]) {
  const client = await feishuSdkClient(bot);
  const chunks = chunkUsersRecords(records);

  const personListCardId = await createCardEntity(client, usersPersonListCard(records));
  const personListReply = await replyCardReference(client, messageId, personListCardId);
  await appendUsersCardElements(client, personListCardId, chunks, (chunk, index) => [
    usersDividerElement(index),
    usersPersonListElement(chunk, index)
  ]);

  const personListMessageId = personListReply.data?.message_id;
  if (!personListMessageId) throw new Error('failed to get person list message id');
  const markdownCardId = await createCardEntity(client, usersMarkdownCard(records));
  await replyCardReference(client, personListMessageId, markdownCardId, true);
  await appendUsersCardElements(client, markdownCardId, chunks, (chunk, index) => [usersMarkdownElement(chunk, index)]);
}

async function handleFeishuCommand(bot: FeishuBot, event: any, messageId: string, text: string, options: { allowSetDefault: boolean }): Promise<boolean> {
  const message = event?.message;
  if (options.allowSetDefault) {
    const addCron = parseAddCronCommand(text);
    if (addCron.isAddCron) {
      if (!addCron.cronExpr || !addCron.commandText) {
        await replyText(bot, messageId, '用法：/add-cron "*/5 * * * *" "/douyin 123 [--count n]"');
        return true;
      }
      const chatId = String(message?.chat_id || '').trim();
      if (!chatId) {
        await replyText(bot, messageId, '当前消息缺少 chat_id，无法创建会话定时任务');
        return true;
      }
      try {
        const task = addCronTask(bot.id, chatId, addCron.cronExpr, addCron.commandText);
        await replyText(bot, messageId, `已添加定时任务 #${task.id}，下次执行：${task.nextRunAt}\n${addCron.cronExpr} -> ${addCron.commandText}`);
      } catch (error) {
        await replyText(bot, messageId, error instanceof Error ? `添加定时任务失败：${error.message}` : '添加定时任务失败');
      }
      return true;
    }
    const setDefault = parseSetDefaultCommand(text);
    if (setDefault.isSetDefault) {
      const sender = senderIdentity(event);
      if (!sender.id || sender.id === 'unknown') {
        await replyText(bot, messageId, '无法识别当前发送用户，不能设置默认兜底指令');
        return true;
      }
      const currentDefault = getDefaultCommandRecord(bot.id);
      if (currentDefault?.adminUserId && currentDefault.adminUserId !== sender.id) {
        await replyText(bot, messageId, '只有首次设置默认兜底指令的管理员可以修改 /set-default');
        return true;
      }
      if (!setDefault.defaultCommand) {
        await replyText(bot, messageId, '用法：/set-default "{兜底指令}"');
        return true;
      }
      const result = setDefaultCommand(bot.id, setDefault.defaultCommand, sender.id);
      if (!result.ok) {
        await replyText(bot, messageId, '只有首次设置默认兜底指令的管理员可以修改 /set-default');
        return true;
      }
      await replyText(
        bot,
        messageId,
        result.assignedAdmin
          ? `已设置默认兜底指令：${setDefault.defaultCommand}\n你已成为该机器人的 /set-default 管理员。`
          : `已设置默认兜底指令：${setDefault.defaultCommand}`
      );
      return true;
    }
  }
  const douyinCommand = parseDouyinCommand(text);
  if (douyinCommand.isDouyin) {
    if (douyinCommand.shouldDelete) {
      const sender = senderIdentity(event);
      if (!sender.id || sender.id === 'unknown') {
        await replyText(bot, messageId, '无法识别当前发送用户，不能删除抖音收藏记录');
        return true;
      }
      const adminUserId = getDefaultCommandRecord(bot.id)?.adminUserId || '';
      if (!adminUserId) {
        await replyText(bot, messageId, '当前机器人还没有 /set-default 管理员，不能执行 /douyin --delete');
        return true;
      }
      if (adminUserId !== sender.id) {
        await replyText(bot, messageId, '只有该机器人的 /set-default 管理员可以执行 /douyin --delete');
        return true;
      }
      if (douyinCommand.hasInvalidDelete) {
        await replyText(bot, messageId, '用法：/douyin --delete {大于 5 位的数字 aweme_id}');
        return true;
      }
      if (bot.user_id == null) {
        await replyText(bot, messageId, '当前机器人未绑定用户，无法删除抖音收藏记录');
        return true;
      }
      const result = softDeleteDouyinAwemeRecords(bot.user_id, douyinCommand.deleteAwemeId);
      if (result.matched === 0) {
        await replyText(bot, messageId, `未找到 aweme_id=${douyinCommand.deleteAwemeId} 的抖音收藏记录`);
        return true;
      }
      if (result.deleted === 0) {
        await replyText(bot, messageId, `aweme_id=${douyinCommand.deleteAwemeId} 已经是删除状态`);
        return true;
      }
      await replyText(bot, messageId, `已删除 aweme_id=${douyinCommand.deleteAwemeId} 的抖音收藏记录，共 ${result.deleted} 条`);
      return true;
    }
    if (!douyinCommand.clickText) {
      await replyText(bot, messageId, '用法：/douyin {模拟点击文案} [--count n]');
      return true;
    }
    if (douyinCommand.hasInvalidCount) {
      await replyText(bot, messageId, '用法：/douyin {模拟点击文案} [--count n]，其中 n 必须为大于 0 的整数');
      return true;
    }
    if (bot.user_id == null) {
      await replyText(bot, messageId, '当前机器人未绑定用户，无法读取抖音收藏记录');
      return true;
    }
    await sendDouyinMessages(bot, douyinCommand.clickText, douyinCommand.count, (messageText) => replyText(bot, messageId, messageText));
    return true;
  }

  const command = parseUsersCommand(text);
  if (!command.isUsers) {
    return false;
  }

  const atBy = senderIdentity(event);
  const mentions = mentionedUsers(bot, message);
  const atWhos = mentions.map((mention) => mention.id);
  debugFeishu('users.command', {
    botId: bot.id,
    messageId,
    atBy,
    text,
    command,
    atWhos,
    acceptedMentions: mentions
  });
  if (command.shouldDelete) {
    softDeleteMentions(bot.id, atBy.id, atWhos);
  } else {
    upsertMentions(bot.id, atBy.id, atBy.name, mentions);
    if (command.shouldTop) topMentions(bot.id, atBy.id, atWhos);
  }

  await replyUsersCard(bot, messageId, listMentions(bot.id, atBy.id, command.newCount));
  return true;
}

export async function handleFeishuMessage(bot: FeishuBot, event: any) {
  const message = event?.message;
  const messageId = message?.message_id;
  const text = textFromMessage(message);
  if (!messageId || !text) {
    console.log('[feishu] message ignored before handling', {
      botId: bot.id,
      messageId: messageId || '',
      chatId: message?.chat_id || '',
      messageType: message?.message_type || '',
      hasText: Boolean(text)
    });
    return;
  }
  const dedupKey = `message:${messageId}`;
  if (!rememberFeishuEventKey(dedupKey)) {
    console.log('[feishu] duplicate message skipped', {
      botId: bot.id,
      dedupKey,
      messageId,
      chatId: message?.chat_id || ''
    });
    return;
  }
  console.log('[feishu] message handling start', {
    botId: bot.id,
    messageId,
    chatId: message?.chat_id || '',
    messageType: message?.message_type || '',
    text
  });

  if (isFromCurrentBot(bot, event)) {
    console.log('[feishu] self message skipped', {
      botId: bot.id,
      messageId,
      chatId: message?.chat_id || ''
    });
    return;
  }

  const chatId = messageChatId(message);
  const chatType = String(message?.chat_type || '').trim();
  const isPrivateChat = chatType === 'p2p';
  const mentionsBot = messageMentionsBot(bot, message);
  const shouldHandleCommand = isPrivateChat || mentionsBot;

  const history = chatId ? readRecentChatMessages(bot.id, chatId, passiveInteractionConfig().contextSize) : [];
  rememberRecentChatMessage(bot, event, text);

  if (shouldHandleCommand) {
    if (await handleFeishuCommand(bot, event, messageId, text, { allowSetDefault: true })) {
      console.log('[feishu] explicit command handled, passive interaction skipped', {
        botId: bot.id,
        messageId,
        chatId: message?.chat_id || ''
      });
      return;
    }

    const defaultCommand = getDefaultCommand(bot.id);
    if (defaultCommand) {
      if (await handleFeishuCommand(bot, event, messageId, defaultCommand, { allowSetDefault: false })) {
        console.log('[feishu] default command handled as command', {
          botId: bot.id,
          messageId,
          chatId: message?.chat_id || ''
        });
        return;
      }
      await replyText(bot, messageId, defaultCommand);
      console.log('[feishu] default command replied as text', {
        botId: bot.id,
        messageId,
        chatId: message?.chat_id || ''
      });
      return;
    }
  }

  await runPassiveInteractions(bot, event, messageId, text, history);
}

function getOwnedBot(id: number, userId: number) {
  return db.prepare('SELECT * FROM feishu_bots WHERE id = ? AND user_id = ?').get(id, userId) as FeishuBot | undefined;
}

export function listFeishuBots(req: AuthenticatedRequest, res: Response) {
  const rows = db.prepare('SELECT * FROM feishu_bots WHERE user_id = ? ORDER BY id DESC').all(req.user?.id) as FeishuBot[];
  res.json({ bots: rows.map(publicBot) });
}

export function createFeishuBotForUser(userId: number, body: any) {
  const { name, appId, appSecret, domain = 'feishu', verificationToken = '', encryptKey = '' } = body || {};
  if (!name || !appId || !appSecret) {
    return { status: 400, error: 'name, appId and appSecret are required' };
  }
  if (!['feishu', 'lark'].includes(domain)) {
    return { status: 400, error: 'domain must be feishu or lark' };
  }
  const result = db.prepare(`
    INSERT INTO feishu_bots (user_id, name, app_id, app_secret, domain, verification_token, encrypt_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, name, appId, appSecret, domain, verificationToken, encryptKey);
  return { status: 201, bot: getBot(Number(result.lastInsertRowid)) };
}

export function createFeishuBotFromCredentials(userId: number, body: { name: string; appId: string; appSecret: string; domain: string }) {
  return createFeishuBotForUser(userId, {
    name: body.name,
    appId: body.appId,
    appSecret: body.appSecret,
    domain: body.domain,
    verificationToken: '',
    encryptKey: ''
  });
}

export function createFeishuBot(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const result = createFeishuBotForUser(req.user.id, req.body);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const bot = result.bot;
  res.status(201).json({ bot: bot && publicBot(bot) });
}

export function deleteOwnedFeishuBot(botId: number, userId: number) {
  if (!getOwnedBot(botId, userId)) return false;
  db.prepare('DELETE FROM feishu_bot_default_commands WHERE bot_id = ?').run(botId);
  db.prepare('DELETE FROM feishu_chat_cron_tasks WHERE bot_id = ?').run(botId);
  db.prepare('DELETE FROM feishu_bots WHERE id = ? AND user_id = ?').run(botId, userId);
  tokenCache.delete(botId);
  return true;
}

export function deleteFeishuBot(req: AuthenticatedRequest, res: Response) {
  const botId = Number(req.params.id);
  if (!req.user || !deleteOwnedFeishuBot(botId, req.user.id)) {
    res.status(404).json({ error: 'bot not found' });
    return;
  }
  res.status(204).end();
}

export async function probeFeishuBot(req: AuthenticatedRequest, res: Response) {
  const bot = req.user ? getOwnedBot(Number(req.params.id), req.user.id) : undefined;
  if (!bot) {
    res.status(404).json({ error: 'bot not found' });
    return;
  }
  try {
    res.json({ ok: true, ...(await probeBot(bot)) });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'probe failed' });
  }
}

export async function feishuWebhook(req: Request, res: Response) {
  const bot = getBot(Number(req.params.id));
  if (!bot || !bot.enabled) {
    res.status(404).json({ error: 'bot not found' });
    return;
  }

  const payload = req.body || {};
  if (payload.type === 'url_verification') {
    res.json({ challenge: payload.challenge || '' });
    return;
  }

  const incomingToken = String(payload.header?.token || payload.token || '');
  if (bot.verification_token && incomingToken !== bot.verification_token) {
    res.status(401).send('Invalid verification token');
    return;
  }

  const eventType = payload.header?.event_type || payload.type;
  if (eventType === 'im.message.receive_v1') {
    const eventId = String(payload.header?.event_id || payload.event?.message?.message_id || '').trim();
    const messageId = String(payload.event?.message?.message_id || '').trim();
    console.log('[feishu] webhook message received', { botId: bot.id, eventId, messageId });
    handleFeishuMessage(bot, payload.event).catch((error) => {
      console.error('[feishu] message handling failed', {
        botId: bot.id,
        messageId,
        eventId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  res.json({ ok: true });
}

async function executeCronTask(task: ChatCronTask) {
  const bot = getBot(task.bot_id);
  if (!bot || !bot.enabled) return;
  const douyinCommand = parseDouyinCommand(task.command_text);
  if (!douyinCommand.isDouyin) {
    await sendTextToChat(bot, task.chat_id, `定时任务 #${task.id} 暂不支持该指令：${task.command_text}`);
    return;
  }
  if (douyinCommand.shouldDelete) {
    await sendTextToChat(bot, task.chat_id, `定时任务 #${task.id} 不支持 /douyin --delete，请由管理员手动执行`);
    return;
  }
  if (!douyinCommand.clickText) {
    await sendTextToChat(bot, task.chat_id, `定时任务 #${task.id} 配置错误：/douyin 缺少模拟点击文案，格式应为 /douyin {模拟点击文案} [--count n]`);
    return;
  }
  if (douyinCommand.hasInvalidCount) {
    await sendTextToChat(bot, task.chat_id, `定时任务 #${task.id} 配置错误：/douyin 的 --count 必须为大于 0 的整数`);
    return;
  }
  if (bot.user_id == null) {
    await sendTextToChat(bot, task.chat_id, `定时任务 #${task.id} 执行失败：当前机器人未绑定用户`);
    return;
  }
  await sendDouyinMessages(bot, douyinCommand.clickText, douyinCommand.count, (messageText) => sendTextToChat(bot, task.chat_id, messageText));
}

async function runCronSchedulerTick() {
  if (cronSchedulerRunning) return;
  cronSchedulerRunning = true;
  try {
    const now = new Date();
    const tasks = db.prepare(`
      SELECT id, bot_id, chat_id, cron_expr, command_text, next_run_at
      FROM feishu_chat_cron_tasks
      WHERE enabled = 1 AND next_run_at <= ?
      ORDER BY next_run_at ASC, id ASC
      LIMIT 20
    `).all(now.toISOString()) as ChatCronTask[];
    for (const task of tasks) {
      const nextRunAt = nextCronRunAt(task.cron_expr, now).toISOString();
      db.prepare(`
        UPDATE feishu_chat_cron_tasks
        SET last_run_at = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(now.toISOString(), nextRunAt, task.id);
      executeCronTask(task).catch((error) => console.error('[feishu:cron] task failed', { taskId: task.id, error }));
    }
  } finally {
    cronSchedulerRunning = false;
  }
}

export function startFeishuCronScheduler() {
  if (cronSchedulerTimer) return;
  cronSchedulerTimer = setInterval(() => void runCronSchedulerTick(), 30_000);
  void runCronSchedulerTick();
}

export function stopFeishuCronScheduler() {
  if (cronSchedulerTimer) clearInterval(cronSchedulerTimer);
  cronSchedulerTimer = undefined;
}
