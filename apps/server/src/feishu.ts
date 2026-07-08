import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Request, Response as ExpressResponse } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { db } from './db.js';
import { randomDouyinAwemeIds, setDouyinAwemeNotifier, softDeleteDouyinAwemeRecords } from './douyin.js';
import { renderStyleStickerImage, type StickerFlavor } from './styleStickers.js';

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
  hasCountFlag: boolean;
  shouldDelete: boolean;
  shouldSubscribe: boolean;
  shouldUnsubscribe: boolean;
  deleteAwemeId: string;
  hasInvalidCount: boolean;
  hasInvalidDelete: boolean;
  hasConflictingAction: boolean;
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

type HelpCommandRow = {
  command: string;
  params: string;
  description: string;
};

type PassiveFeature = 'reaction' | 'repeat' | 'llm_reply' | 'media_repeat' | 'image_reverse' | 'sticker_reverse';

type PassiveToggleCommand =
  | { isPassiveToggle: false }
  | {
    isPassiveToggle: true;
    command: string;
    feature: PassiveFeature;
    featureName: string;
    shouldEnable: boolean;
    shouldDisable: boolean;
    hasConflictingAction: boolean;
    hasUnknownArgs: boolean;
  };

type StyleStickerFeature = 'byte_style' | 'scale_new_heights';

type StyleStickerCommand =
  | { isStyleSticker: false }
  | {
    isStyleSticker: true;
    command: string;
    feature: StyleStickerFeature;
    featureName: string;
    flavor: StickerFlavor;
    shouldEnable: boolean;
    shouldDisable: boolean;
    maxChars?: number;
    hasConflictingAction: boolean;
    hasInvalidMax: boolean;
    text: string;
  };

type ChatCronTask = {
  id: number;
  bot_id: number;
  chat_id: string;
  cron_expr: string;
  command_text: string;
  next_run_at: string;
};

type DouyinSubscriptionRecord = {
  id: number;
  bot_id: number;
  chat_id: string;
  click_text: string;
};

type CronField = {
  values: Set<number>;
  unrestricted: boolean;
};

type PassiveInteractionConfig = {
  reactionRate: number;
  repeatRate: number;
  imageRepeatRate: number;
  imageReverseImageRate: number;
  imageReverseStickerRate: number;
  byteStyleRate: number;
  scaleNewHeightsRate: number;
  imitateRate: number;
  repeatMaxChars: number;
  styleStickerDefaultMaxChars: number;
  styleStickerMaxCharsLimit: number;
  contextSize: number;
  reactionEmojis: string[];
  llmUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  llmMaxTokens: number;
  llmDisableThinking: boolean;
};

type RecentChatMessage = {
  senderId: string;
  senderName: string;
  text: string;
  createdAt: number;
};

type ParsedFeishuMessage = {
  messageType: string;
  text: string;
  imageKey: string;
  stickerFileKey: string;
};

type DownloadedMessageResource = {
  data: Buffer;
  contentType: string;
  fileName: string;
  filePath: string;
};

type PassiveMediaResource = {
  sourceType: 'image' | 'sticker';
  fileKey: string;
  resource: DownloadedMessageResource;
};

type MirroredImageVariant = {
  axis: 'vertical' | 'horizontal';
  sourceSide: 'start' | 'end';
};

type StyleStickerChatSetting = {
  enabled: boolean;
  maxChars: number;
  hasCustomMax: boolean;
  isCapped: boolean;
};

type StyleStickerCardAction = 'preview' | 'send' | 'withdraw';

type StyleStickerCardState = {
  feature: StyleStickerFeature;
  text: string;
  color1: string;
  color2: string;
  gradientAngle: number;
  imageKey: string;
};

let cronSchedulerTimer: NodeJS.Timeout | undefined;
let cronSchedulerRunning = false;
const moduleDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(moduleDir);
const appRootDir = basename(appDir) === 'dist' ? dirname(appDir) : appDir;
const execFileAsync = promisify(execFile);
const FEISHU_EVENT_DEDUP_TTL_MS = 10 * 60 * 1000;
const MESSAGE_RESOURCE_MAX_BYTES = 4 * 1024 * 1024;
const MESSAGE_RESOURCE_CACHE_DIR = join(tmpdir(), 'dogebot-feishu-image-cache');
const MESSAGE_RESOURCE_PROCESSED_DIR = join(tmpdir(), 'dogebot-feishu-image-processed');
const MESSAGE_RESOURCE_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MESSAGE_RESOURCE_CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
function resolveRuntimeScriptPath(fileName: string) {
  const candidates = [
    join(appDir, 'scripts', fileName),
    join(appRootDir, 'scripts', fileName)
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  return matched || candidates[0];
}

const IMAGE_MIRROR_SCRIPT_PATH = resolveRuntimeScriptPath('mirror-image.py');
const recentFeishuEventKeys = new Map<string, number>();
const messageResourceCache = new Map<string, string>();
const messageResourceDownloads = new Map<string, Promise<DownloadedMessageResource>>();
const USERS_CARD_PERSON_LIST_CHUNK_SIZE = 100;
const CARD_REFERENCE_READY_DELAY_MS = 1000;
const RECENT_CHAT_MEMORY_LIMIT = 30;
const STYLE_STICKER_CARD_KIND = 'style_sticker_generator';
const STYLE_STICKER_FORM_NAME = 'style_sticker_form';
const STYLE_STICKER_FORM_FIELDS = {
  text: 'text',
  color1: 'color1',
  color2: 'color2',
  customColor1: 'customColor1',
  customColor2: 'customColor2',
  gradientAngle: 'gradientAngle'
} as const;
const STYLE_STICKER_CARD_COLOR_OPTIONS = [
  '#9af665',
  '#44b305',
  '#ef6cdf',
  '#ed12d3',
  '#ff975c',
  '#fb5b00',
  '#69d1f2',
  '#0989b2',
  '#fb609e',
  '#fa0064',
  '#73e8d7',
  '#14a38e',
  '#ffb65c',
  '#ff8d00',
  '#5eb4fc',
  '#0089ff',
  '#755df6',
  '#2c06f9'
] as const;
const DEFAULT_REACTION_EMOJIS = ['OK', 'DONE', 'THUMBSUP', 'HEART', 'LAUGH'];
let messageResourceCacheCleanupTimer: NodeJS.Timeout | undefined;
const PASSIVE_TOGGLE_COMMANDS = [
  { command: '/reaction', feature: 'reaction', featureName: '贴表情' },
  { command: '/repeat', feature: 'repeat', featureName: '复读' },
  { command: '/llm-reply', feature: 'llm_reply', featureName: '大模型接话' },
  { command: '/media-repeat', feature: 'media_repeat', featureName: '图片/表情包复读' },
    { command: '/image-reverse', feature: 'image_reverse', featureName: '图片镜像反转' },
    { command: '/sticker-reverse', feature: 'sticker_reverse', featureName: '表情包镜像反转' }
] as const;
const STYLE_STICKER_COMMANDS = [
  { command: '/byte-style', feature: 'byte_style', featureName: '字节范', flavor: 'bs' },
  { command: '/字节范', feature: 'byte_style', featureName: '字节范', flavor: 'bs' },
  { command: '/scale-new-heights', feature: 'scale_new_heights', featureName: '勇攀高峰', flavor: 'snh' },
  { command: '/勇攀高峰', feature: 'scale_new_heights', featureName: '勇攀高峰', flavor: 'snh' }
] as const;
const HELP_COMMAND_ROWS: HelpCommandRow[] = [
  {
    command: '/help',
    params: '无',
    description: '查看当前机器人支持的斜杠命令、可填参数和功能说明。'
  },
  {
    command: '/users',
    params: '@用户...、delete [@用户...]、top @用户、new n',
    description: '记录和查看当前发起人 at 过的用户；支持删除、置顶和只看最新 n 个。'
  },
  {
    command: '/douyin',
    params: '{模拟点击文案} [--count n]',
    description: '随机发送匹配文案的抖音收藏视频；n 必须是大于 0 的整数。'
  },
  {
    command: '/douyin',
    params: '--subscribe {模拟点击文案} / --unsubscribe {模拟点击文案}',
    description: '订阅或取消订阅当前会话的抖音收藏分组新增视频通知。'
  },
  {
    command: '/douyin',
    params: '--delete {aweme_id}',
    description: '软删除指定抖音收藏记录；仅 /set-default 管理员可用，aweme_id 需大于 5 位。'
  },
  {
    command: '/set-default',
    params: '"{兜底指令}"',
    description: '设置当前 bot 的默认兜底指令；首次设置者会成为该命令管理员。'
  },
  {
    command: '/add-cron',
    params: '"*/5 * * * *" "[命令]"',
    description: '给当前会话添加定时任务；命令可省略，省略时使用 /set-default 配置。'
  },
  {
    command: '/reaction、/repeat、/llm-reply',
    params: '--enable / --disable',
    description: '开启或关闭当前会话的贴表情、文本复读、大模型接话等被动能力。'
  },
  {
    command: '/media-repeat、/image-reverse、/sticker-reverse',
    params: '--enable / --disable',
    description: '开启或关闭当前会话的图片/表情包复读、图片镜像、表情包镜像能力。'
  },
  {
    command: '/byte-style、/字节范',
    params: '[文案]、--enable、--disable、--max n',
    description: '把文案生成“字节范”图片；不带参数会发交互卡片；开关和 --max 控制随机生图。'
  },
  {
    command: '/scale-new-heights、/勇攀高峰',
    params: '[文案]、--enable、--disable、--max n',
    description: '把文案生成“勇攀高峰”图片；不带参数会发交互卡片；开关和 --max 控制随机生图。'
  }
];
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function parseFeishuMessage(message: any): ParsedFeishuMessage {
  const messageType = String(message?.message_type || '').trim();
  const content = safeParseMessageContent(message);
  if (messageType === 'text') {
    return {
      messageType,
      text: String(content.text || '').trim(),
      imageKey: '',
      stickerFileKey: ''
    };
  }
  if (messageType === 'image') {
    return {
      messageType,
      text: '',
      imageKey: String(content.image_key || '').trim(),
      stickerFileKey: ''
    };
  }
  if (messageType === 'sticker') {
    return {
      messageType,
      text: '',
      imageKey: '',
      stickerFileKey: String(content.file_key || '').trim()
    };
  }
  if (messageType === 'post') {
    const post = extractPostTextAndImage(content);
    return {
      messageType,
      text: post.text,
      imageKey: post.imageKey,
      stickerFileKey: ''
    };
  }
  return {
    messageType,
    text: '',
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

async function createChatMessage(bot: FeishuBot, chatId: string, msgType: string, content: Record<string, unknown>) {
  const token = await tenantAccessToken(bot);
  try {
    await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) })
    });
  } catch (error) {
    console.error('[feishu] chat message send failed', {
      botId: bot.id,
      chatId,
      msgType,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function replyText(bot: FeishuBot, messageId: string, text: string, replyInThread = false) {
  const token = await tenantAccessToken(bot);
  try {
    await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: replyInThread })
    });
    // console.log('[feishu] text reply send success', { botId: bot.id, messageId, textLength: text.length });
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
  await createChatMessage(bot, chatId, 'text', { text });
}

async function sendImageToChat(bot: FeishuBot, chatId: string, imageKey: string) {
  await createChatMessage(bot, chatId, 'image', { image_key: imageKey });
}

async function sendStickerToChat(bot: FeishuBot, chatId: string, fileKey: string) {
  await createChatMessage(bot, chatId, 'sticker', { file_key: fileKey });
}

function styleStickerFlavor(feature: StyleStickerFeature): StickerFlavor {
  return feature === 'byte_style' ? 'bs' : 'snh';
}

function styleStickerCommandName(feature: StyleStickerFeature) {
  return feature === 'byte_style' ? '/byte-style' : '/scale-new-heights';
}

function styleStickerFeatureName(feature: StyleStickerFeature) {
  return feature === 'byte_style' ? '字节范' : '勇攀高峰';
}

async function sendStyleStickerToChat(
  bot: FeishuBot,
  chatId: string,
  feature: StyleStickerFeature,
  text: string,
  options: { color1?: unknown; color2?: unknown; gradientAngle?: unknown } = {}
) {
  const { image } = await renderStyleStickerImage(text, styleStickerFlavor(feature), options);
  const imageKey = await uploadImage(bot, image, `${styleStickerCommandName(feature).slice(1)}.png`);
  await sendImageToChat(bot, chatId, imageKey);
}

function plainText(content: string) {
  return { tag: 'plain_text', content };
}

function styleStickerCardHeaderTemplate(feature: StyleStickerFeature) {
  return feature === 'byte_style' ? 'purple' : 'blue';
}

function styleStickerCardButton(action: StyleStickerCardAction, feature: StyleStickerFeature) {
  return {
    tag: 'button',
    name: `style_sticker_${action}`,
    text: plainText(action === 'preview' ? '预览' : action === 'send' ? '发送' : '撤回'),
    type: action === 'send' ? 'primary_filled' : action === 'withdraw' ? 'danger_filled' : 'default',
    width: 'fill',
    form_action_type: 'submit',
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: STYLE_STICKER_CARD_KIND,
          action,
          feature
        }
      }
    ]
  };
}

function hexToRgba(hexColor: string, alpha = 1) {
  const normalized = hexColor.replace(/^#/, '');
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
}

function styleStickerCardColorStyles() {
  return Object.fromEntries(
    STYLE_STICKER_CARD_COLOR_OPTIONS.map((color, index) => [
      `cus-${index}`,
      {
        light_mode: hexToRgba(color),
        dark_mode: hexToRgba(color)
      }
    ])
  );
}

function styleStickerColorSelect(field: 'color1' | 'color2', label: string, value: string) {
  const initialOption = STYLE_STICKER_CARD_COLOR_OPTIONS.includes(value as (typeof STYLE_STICKER_CARD_COLOR_OPTIONS)[number])
    ? value
    : STYLE_STICKER_CARD_COLOR_OPTIONS[0];
  return {
    tag: 'select_static',
    element_id: `style_sticker_${field}`,
    name: STYLE_STICKER_FORM_FIELDS[field],
    placeholder: plainText(`选择${label}`),
    initial_option: initialOption,
    type: 'default',
    width: 'fill',
    options: STYLE_STICKER_CARD_COLOR_OPTIONS.map((color, index) => ({
      text: plainText(`色值 ${index + 1}：${color}`),
      value: color,
      icon: {
        tag: 'standard_icon',
        token: 'signature_outlined',
        color: `cus-${index}`
      }
    }))
  };
}

function styleStickerCustomColorInput(field: 'customColor1' | 'customColor2', label: string) {
  return {
    tag: 'input',
    element_id: `sticker_${field}`,
    name: STYLE_STICKER_FORM_FIELDS[field],
    label: plainText(`${label}自定义`),
    placeholder: plainText('#RRGGBB，填了会优先生效'),
    max_length: 7
  };
}

function buildStyleStickerCard(state: StyleStickerCardState) {
  const featureName = styleStickerFeatureName(state.feature);
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: false,
      summary: { content: `${featureName}生图卡片` },
      style: {
        color: styleStickerCardColorStyles()
      }
    },
    header: {
      title: plainText(`${featureName}生成器`),
      template: styleStickerCardHeaderTemplate(state.feature)
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'img',
          element_id: 'style_sticker_preview',
          img_key: state.imageKey,
          alt: plainText(`${featureName}预览图`),
          mode: 'fit_horizontal',
          preview: true
        },
        {
          tag: 'markdown',
          content: `颜色：\`${state.color1}\` / \`${state.color2}\`，渐变角度：\`${state.gradientAngle}°\``
        },
        {
          tag: 'form',
          element_id: STYLE_STICKER_FORM_NAME,
          name: STYLE_STICKER_FORM_NAME,
          direction: 'vertical',
          vertical_spacing: '10px',
          elements: [
            {
              tag: 'input',
              element_id: 'style_sticker_text',
              name: STYLE_STICKER_FORM_FIELDS.text,
              label: plainText('文案'),
              placeholder: plainText('输入要生成的文案'),
              default_value: state.text,
              input_type: 'multiline_text',
              rows: 2,
              auto_resize: true,
              max_rows: 4,
              required: true,
              max_length: 150
            },
            {
              tag: 'markdown',
              content: '**选择颜色**：先从下拉选常用色；如果填写自定义色值（如 `#ff00aa`），会优先使用自定义色值。'
            },
            {
              tag: 'column_set',
              flex_mode: 'trisect',
              horizontal_spacing: '8px',
              columns: [
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [
                    styleStickerColorSelect('color1', '颜色 1', state.color1),
                    styleStickerCustomColorInput('customColor1', '颜色 1')
                  ]
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [
                    styleStickerColorSelect('color2', '颜色 2', state.color2),
                    styleStickerCustomColorInput('customColor2', '颜色 2')
                  ]
                }
              ]
            },
            {
              tag: 'input',
              element_id: 'style_sticker_gradient_angle',
              name: STYLE_STICKER_FORM_FIELDS.gradientAngle,
              label: plainText('渐变角度（0-360）'),
              placeholder: plainText('例如 90'),
              default_value: String(state.gradientAngle),
              max_length: 3
            },
            {
              tag: 'column_set',
              flex_mode: 'trisect',
              horizontal_spacing: '8px',
              columns: [
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [styleStickerCardButton('withdraw', state.feature)]
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [styleStickerCardButton('preview', state.feature)]
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [styleStickerCardButton('send', state.feature)]
                }
              ]
            }
          ]
        }
      ]
    }
  };
}

async function renderStyleStickerCardState(
  bot: FeishuBot,
  feature: StyleStickerFeature,
  text: string,
  options: { color1?: unknown; color2?: unknown; gradientAngle?: unknown } = {}
) {
  const fallbackText = styleStickerFeatureName(feature);
  const renderText = text.trim() || fallbackText;
  const { image, colors, gradientAngle } = await renderStyleStickerImage(renderText, styleStickerFlavor(feature), options);
  const imageKey = await uploadImage(bot, image, `${styleStickerCommandName(feature).slice(1)}-preview.png`);
  return {
    feature,
    text: renderText,
    color1: colors[0],
    color2: colors[1],
    gradientAngle,
    imageKey
  };
}

async function replyStyleStickerGeneratorCard(bot: FeishuBot, messageId: string, feature: StyleStickerFeature) {
  const state = await renderStyleStickerCardState(bot, feature, styleStickerFeatureName(feature));
  await replyCard(bot, messageId, buildStyleStickerCard(state));
}

function helpTableCell(content: string, weight: number, bold = false) {
  return {
    tag: 'column',
    width: 'weighted',
    weight,
    vertical_align: 'top',
    elements: [
      {
        tag: 'markdown',
        content: bold ? `**${content}**` : content
      }
    ]
  };
}

function helpTableRow(row: HelpCommandRow, index: number) {
  return {
    tag: 'column_set',
    element_id: `help_row_${index}`,
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      helpTableCell(row.command, 2),
      helpTableCell(row.params, 3),
      helpTableCell(row.description, 5)
    ]
  };
}

function buildHelpCard() {
  const elements: object[] = [
    {
      tag: 'markdown',
      content: '下面是当前支持的斜杠命令。群聊里需要先 @ 机器人，单聊里可以直接发送。'
    },
    {
      tag: 'column_set',
      element_id: 'help_header',
      flex_mode: 'none',
      horizontal_spacing: '8px',
      columns: [
        helpTableCell('命令', 2, true),
        helpTableCell('可填参数', 3, true),
        helpTableCell('功能', 5, true)
      ]
    },
    { tag: 'hr' }
  ];

  HELP_COMMAND_ROWS.forEach((row, index) => {
    elements.push(helpTableRow(row, index));
    if (index < HELP_COMMAND_ROWS.length - 1) elements.push({ tag: 'hr' });
  });

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      summary: { content: 'DogeBot 命令帮助' }
    },
    header: {
      title: plainText('DogeBot 命令帮助'),
      template: 'blue'
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      vertical_spacing: '8px',
      elements
    }
  };
}

async function replyHelpCard(bot: FeishuBot, messageId: string) {
  await replyCard(bot, messageId, buildHelpCard());
}

async function addReaction(bot: FeishuBot, messageId: string, reactionType: string) {
  const token = await tenantAccessToken(bot);
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

async function updateInteractiveMessage(bot: FeishuBot, messageId: string, card: object) {
  const token = await tenantAccessToken(bot);
  await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: JSON.stringify(card) })
  });
}

async function deleteMessage(bot: FeishuBot, messageId: string) {
  const token = await tenantAccessToken(bot);
  await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` }
  });
}

function debugFeishu(label: string, payload: unknown) {
  if (process.env.DOGEBOT_FEISHU_DEBUG !== '1') return;
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

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isStyleStickerFeature(value: unknown): value is StyleStickerFeature {
  return value === 'byte_style' || value === 'scale_new_heights';
}

function isStyleStickerCardAction(value: unknown): value is StyleStickerCardAction {
  return value === 'preview' || value === 'send' || value === 'withdraw';
}

function firstStringValue(value: unknown) {
  if (Array.isArray(value)) return firstStringValue(value[0]);
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function formStringValue(formValue: Record<string, any>, field: string) {
  return firstStringValue(formValue[field]);
}

function normalizeCardHexColor(value: unknown) {
  const text = firstStringValue(value);
  if (!text) return '';
  const normalized = text.startsWith('#') ? text : `#${text}`;
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : '';
}

function normalizeCardGradientAngle(value: unknown) {
  const parsed = Number(firstStringValue(value));
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(360, Math.max(0, Math.round(parsed)));
}

function parseStyleStickerCardActionPayload(payload: any) {
  const event = payload?.event || payload;
  const actionValue = event?.action?.value;
  if (!isRecord(actionValue) || actionValue.kind !== STYLE_STICKER_CARD_KIND) return null;
  if (!isStyleStickerFeature(actionValue.feature) || !isStyleStickerCardAction(actionValue.action)) return null;

  const messageId = String(
    event?.context?.open_message_id ||
      event?.open_message_id ||
      event?.message_id ||
      payload?.context?.open_message_id ||
      payload?.open_message_id ||
      ''
  ).trim();
  const chatId = String(
    event?.context?.open_chat_id ||
      event?.open_chat_id ||
      event?.chat_id ||
      payload?.context?.open_chat_id ||
      payload?.open_chat_id ||
      ''
  ).trim();
  if (!messageId || !chatId) return null;

  return {
    eventId: String(payload?.header?.event_id || event?.event_id || '').trim(),
    messageId,
    chatId,
    feature: actionValue.feature,
    action: actionValue.action,
    formValue: isRecord(event?.action?.form_value) ? event.action.form_value : {}
  };
}

export async function handleFeishuCardAction(bot: FeishuBot, payload: any) {
  const parsed = parseStyleStickerCardActionPayload(payload);
  if (!parsed) return;
  if (parsed.eventId && !rememberFeishuEventKey(`card:${parsed.eventId}`)) return;

  if (parsed.action === 'withdraw') {
    try {
      await deleteMessage(bot, parsed.messageId);
    } catch (error) {
      console.error('[feishu] style sticker card delete failed', {
        botId: bot.id,
        messageId: parsed.messageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  const text = formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.text) || styleStickerFeatureName(parsed.feature);
  const color1 = normalizeCardHexColor(formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.customColor1)) ||
    formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.color1);
  const color2 = normalizeCardHexColor(formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.customColor2)) ||
    formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.color2);
  const gradientAngle = normalizeCardGradientAngle(formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.gradientAngle));

  try {
    const state = await renderStyleStickerCardState(bot, parsed.feature, text, {
      color1,
      color2,
      gradientAngle
    });
    if (parsed.action === 'preview') {
      await updateInteractiveMessage(bot, parsed.messageId, buildStyleStickerCard(state));
      return;
    }

    try {
      await deleteMessage(bot, parsed.messageId);
    } catch (error) {
      console.error('[feishu] style sticker card delete failed', {
        botId: bot.id,
        messageId: parsed.messageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    await sendImageToChat(bot, parsed.chatId, state.imageKey);
  } catch (error) {
    console.error('[feishu] style sticker card action failed', {
      botId: bot.id,
      messageId: parsed.messageId,
      action: parsed.action,
      feature: parsed.feature,
      error: error instanceof Error ? error.message : String(error)
    });
  }
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

function parseBooleanFlag(raw: string | undefined, fallback = false) {
  if (!raw?.trim()) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
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
  const repeatRate = parseRate(process.env.DOGEBOT_FEISHU_REPEAT_RATE, 0.05);
  const styleStickerDefaultMaxChars = parsePositiveInt(process.env.DOGEBOT_FEISHU_STYLE_STICKER_MAX_CHARS, 10);
  return {
    reactionRate: parseRate(process.env.DOGEBOT_FEISHU_REACTION_RATE, 0.1),
    repeatRate,
      imageRepeatRate: parseRate(process.env.DOGEBOT_FEISHU_IMAGE_REPEAT_RATE, 0),
      imageReverseImageRate: parseRate(process.env.DOGEBOT_FEISHU_IMAGE_REVERSE_IMAGE_RATE, 0.05),
      imageReverseStickerRate: parseRate(process.env.DOGEBOT_FEISHU_IMAGE_REVERSE_STICKER_RATE, 0.2),
    byteStyleRate: parseRate(process.env.DOGEBOT_FEISHU_BYTE_STYLE_RATE, 0.05),
    scaleNewHeightsRate: parseRate(process.env.DOGEBOT_FEISHU_SCALE_NEW_HEIGHTS_RATE, 0.05),
    imitateRate: parseRate(process.env.DOGEBOT_FEISHU_IMITATE_RATE, 0.05),
    repeatMaxChars: parsePositiveInt(process.env.DOGEBOT_FEISHU_REPEAT_MAX_CHARS, 300),
    styleStickerDefaultMaxChars,
    styleStickerMaxCharsLimit: parsePositiveInt(process.env.DOGEBOT_FEISHU_STYLE_STICKER_MAX_CHARS_LIMIT, 150),
    contextSize: parsePositiveInt(process.env.DOGEBOT_FEISHU_IMITATE_CONTEXT_SIZE, 8),
    reactionEmojis: splitCsv(process.env.DOGEBOT_FEISHU_REACTION_EMOJIS, DEFAULT_REACTION_EMOJIS),
    llmUrl: openAIChatCompletionsUrl(envString('DOGEBOT_LLM_URL', 'DOGEBOT_LLM_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE')),
    llmApiKey: envString('DOGEBOT_LLM_API_KEY', 'OPENAI_API_KEY'),
    llmModel: envString('DOGEBOT_LLM_MODEL', 'OPENAI_MODEL'),
    llmTimeoutMs: parsePositiveInt(envString('DOGEBOT_LLM_TIMEOUT_MS', 'OPENAI_TIMEOUT_MS'), 15_000),
    llmMaxTokens: parsePositiveInt(process.env.DOGEBOT_LLM_MAX_TOKENS, 160),
      llmDisableThinking: parseBooleanFlag(process.env.DOGEBOT_LLM_DISABLE_THINKING)
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

function messageThreadId(message: any) {
  return String(message?.thread_id || '').trim();
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

async function generateImitationReply(bot: FeishuBot, event: any, text: string, history: RecentChatMessage[], config: PassiveInteractionConfig) {
  const sender = senderIdentity(event);
  const chatId = messageChatId(event?.message);
  const historyBlock = chatHistoryLines(history).join('\n') || '(暂无历史消息)';
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
        '如果你的消息是对具体个人发言的回复，可以 @ 其他人，用飞书消息 at 其他人的 mention 语法：<at user_id="ou_xxx">张三</at>。',
        '回复控制在一句话内，尽量短，最多 80 个中文字符。',
        '如果当前消息不适合接话，输出空字符串。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `bot_id: ${bot.id}`,
        `chat_id: ${chatId}`,
        `当前发言人: ${[sender.name, sender.id].filter(Boolean).join(' (') + (sender.name && sender.id ? ')' : '')}`,
        '',
        '最近群聊：',
        historyBlock,
        '',
        `当前消息：${text}`,
        '',
        '请给出一句自然的群聊接话。'
      ].join('\n')
    }
  ];
  console.log('[feishu] imitate messages input', JSON.stringify(messages, null, 2));
  return openAIChat(config, messages);
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

function guessExtensionFromContentType(contentType: string, fallback = '.bin') {
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/heic') return '.heic';
  if (normalized === 'image/heif') return '.heif';
  if (normalized === 'image/tiff') return '.tiff';
  return fallback;
}

function guessContentTypeFromFileName(fileName: string) {
  const normalized = extname(fileName).toLowerCase();
  if (normalized === '.png') return 'image/png';
  if (normalized === '.jpg' || normalized === '.jpeg') return 'image/jpeg';
  if (normalized === '.webp') return 'image/webp';
  if (normalized === '.gif') return 'image/gif';
  if (normalized === '.heic') return 'image/heic';
  if (normalized === '.heif') return 'image/heif';
  if (normalized === '.tiff' || normalized === '.tif') return 'image/tiff';
  return 'application/octet-stream';
}

function buildMessageResourceUrl(domain: string, messageId: string, fileKey: string, type: 'image' | 'file') {
  return `${openBase(domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`;
}

function sanitizeFileKeyForCache(fileKey: string) {
  return fileKey.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function sanitizeCacheSegment(value: string, fallback: string) {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || fallback;
}

function buildCachedResourceFileName(fileKey: string, sourceType: 'image' | 'sticker', chatId: string, extension: string, timestamp = Date.now()) {
  const sourceMarker = sanitizeCacheSegment(sourceType, 'unknown');
  const chatMarker = sanitizeCacheSegment(chatId, 'unknown_chat');
  return `ts=${timestamp}--src=${sourceMarker}--chat=${chatMarker}--key=${sanitizeFileKeyForCache(fileKey)}${extension}`;
}

function cacheKeyMarker(fileKey: string) {
  return `--key=${sanitizeFileKeyForCache(fileKey)}`;
}

function cacheTimestampFromFileName(fileName: string) {
  const matchedTimestamp = fileName.match(/^ts=(\d+)--/);
  const timestamp = Number(matchedTimestamp?.[1] || '');
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

async function ensureMessageResourceCacheDir() {
  await fs.mkdir(MESSAGE_RESOURCE_CACHE_DIR, { recursive: true });
  if (!messageResourceCacheCleanupTimer) {
    messageResourceCacheCleanupTimer = setInterval(() => {
      cleanupExpiredCachedResources().catch((error) => {
        console.error('[feishu] cached resource cleanup failed', error);
      });
    }, MESSAGE_RESOURCE_CACHE_CLEANUP_INTERVAL_MS);
    messageResourceCacheCleanupTimer.unref?.();
    await cleanupExpiredCachedResources().catch((error) => {
      console.error('[feishu] cached resource initial cleanup failed', error);
    });
  }
}

async function cleanupExpiredCachedResources(now = Date.now()) {
  await fs.mkdir(MESSAGE_RESOURCE_CACHE_DIR, { recursive: true });
  const entries = await fs.readdir(MESSAGE_RESOURCE_CACHE_DIR).catch(() => []);
  for (const entry of entries) {
    const timestamp = cacheTimestampFromFileName(entry);
    if (!timestamp || now - timestamp <= MESSAGE_RESOURCE_CACHE_TTL_MS) continue;
    const filePath = join(MESSAGE_RESOURCE_CACHE_DIR, entry);
    await fs.unlink(filePath).catch(() => undefined);
    for (const [fileKey, cachedFileName] of messageResourceCache) {
      if (cachedFileName === entry) messageResourceCache.delete(fileKey);
    }
  }
}

async function findCachedResourcePath(fileKey: string) {
  await ensureMessageResourceCacheDir();
  const cachedFileName = messageResourceCache.get(fileKey);
  if (cachedFileName) {
    const cachedPath = join(MESSAGE_RESOURCE_CACHE_DIR, cachedFileName);
    const stats = await fs.stat(cachedPath).catch(() => undefined);
    if (stats?.isFile()) {
      if (stats.size >= MESSAGE_RESOURCE_MAX_BYTES) {
        await fs.unlink(cachedPath).catch(() => undefined);
        messageResourceCache.delete(fileKey);
      } else {
        return cachedPath;
      }
    } else {
      messageResourceCache.delete(fileKey);
    }
  }

  const marker = cacheKeyMarker(fileKey);
  const entries = await fs.readdir(MESSAGE_RESOURCE_CACHE_DIR).catch(() => []);
  const matched = entries
    .filter((entry) => entry.includes(marker))
    .sort((left, right) => cacheTimestampFromFileName(right) - cacheTimestampFromFileName(left));
  for (const entry of matched) {
    const filePath = join(MESSAGE_RESOURCE_CACHE_DIR, entry);
    const stats = await fs.stat(filePath).catch(() => undefined);
    if (!stats?.isFile()) continue;
    if (stats.size >= MESSAGE_RESOURCE_MAX_BYTES) {
      await fs.unlink(filePath).catch(() => undefined);
      continue;
    }
    messageResourceCache.set(fileKey, entry);
    return filePath;
  }
  return '';
}

async function refreshCachedResourceTimestamp(fileKey: string, filePath: string) {
  const currentName = basename(filePath);
  if (!/^ts=\d+--/.test(currentName)) return filePath;
  const nextName = currentName.replace(/^ts=\d+--/, `ts=${Date.now()}--`);
  const nextPath = join(MESSAGE_RESOURCE_CACHE_DIR, nextName);
  if (nextPath === filePath) {
    messageResourceCache.set(fileKey, basename(filePath));
    return filePath;
  }
  await fs.rename(filePath, nextPath).catch(async () => {
    await fs.copyFile(filePath, nextPath);
    await fs.unlink(filePath).catch(() => undefined);
  });
  messageResourceCache.set(fileKey, basename(nextPath));
  return nextPath;
}

async function loadCachedMessageResource(fileKey: string): Promise<DownloadedMessageResource | undefined> {
  const cachedPath = await findCachedResourcePath(fileKey);
  if (!cachedPath) return undefined;
  const refreshedPath = await refreshCachedResourceTimestamp(fileKey, cachedPath);
  const data = await fs.readFile(refreshedPath);
  return {
    data,
    contentType: guessContentTypeFromFileName(refreshedPath),
    fileName: basename(refreshedPath),
    filePath: refreshedPath
  };
}

async function saveCachedMessageResource(fileKey: string, data: Buffer, contentType: string, sourceType: 'image' | 'sticker', chatId: string) {
  await ensureMessageResourceCacheDir();
  const extension = guessExtensionFromContentType(contentType, '.bin');
  const filePath = join(MESSAGE_RESOURCE_CACHE_DIR, buildCachedResourceFileName(fileKey, sourceType, chatId, extension));
  await fs.writeFile(filePath, data);
  messageResourceCache.set(fileKey, basename(filePath));
  return filePath;
}

async function probeMessageResourceSize(bot: FeishuBot, messageId: string, fileKey: string, type: 'image' | 'file') {
  const token = await tenantAccessToken(bot);
  const url = buildMessageResourceUrl(bot.domain, messageId, fileKey, type);
  const authHeader = { authorization: `Bearer ${token}` };
  const headResponse = await fetch(url, { method: 'HEAD', headers: authHeader }).catch(() => undefined);
  const headContentLength = Number(headResponse?.headers.get('content-length') || '');
  if (headResponse?.ok && Number.isFinite(headContentLength) && headContentLength >= 0) {
    return headContentLength;
  }

  const rangeResponse = await fetch(url, {
    method: 'GET',
    headers: { ...authHeader, range: 'bytes=0-0' }
  });
  if (!rangeResponse.ok) {
    const errorBody = await rangeResponse.text().catch(() => '');
    throw new Error(`probe message resource size failed: ${rangeResponse.status} ${errorBody}`.trim());
  }
  const contentRange = rangeResponse.headers.get('content-range') || '';
  const matchedTotal = contentRange.match(/\/(\d+)$/);
  const fallbackContentLength = Number(rangeResponse.headers.get('content-length') || '');
  await rangeResponse.body?.cancel().catch(() => undefined);
  if (matchedTotal) return Number(matchedTotal[1]);
  if (rangeResponse.status === 200 && Number.isFinite(fallbackContentLength) && fallbackContentLength >= 0) {
    return fallbackContentLength;
  }
  return 0;
}

async function readResponseBufferWithinLimit(response: globalThis.Response, maxBytes: number, fileKey: string) {
  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength >= maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`message resource too large while downloading: ${contentLength} bytes (${fileKey})`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length >= maxBytes) {
      throw new Error(`message resource too large while downloading: ${data.length} bytes (${fileKey})`);
    }
    return data;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes >= maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`message resource too large while downloading: ${totalBytes} bytes (${fileKey})`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

async function downloadMessageResourceUncached(
  bot: FeishuBot,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  sourceType: 'image' | 'sticker',
  chatId: string
): Promise<DownloadedMessageResource> {
  const token = await tenantAccessToken(bot);
  const response = await fetch(buildMessageResourceUrl(bot.domain, messageId, fileKey, type), {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`download message resource failed: ${response.status} ${errorBody}`.trim());
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const data = await readResponseBufferWithinLimit(response, MESSAGE_RESOURCE_MAX_BYTES, fileKey);
  const filePath = await saveCachedMessageResource(fileKey, data, contentType, sourceType, chatId);
  return {
    data,
    contentType,
    fileName: basename(filePath),
    filePath
  };
}

async function downloadMessageResource(
  bot: FeishuBot,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  sourceType: 'image' | 'sticker',
  chatId: string
): Promise<DownloadedMessageResource> {
  const cacheKey = `${type}:${fileKey}`;
  const inflight = messageResourceDownloads.get(cacheKey);
  if (inflight) return inflight;

  const task = (async () => {
    const cached = await loadCachedMessageResource(fileKey);
    if (cached) return cached;

    const size = await probeMessageResourceSize(bot, messageId, fileKey, type);
      if (Number.isFinite(size) && size > 0 && size >= MESSAGE_RESOURCE_MAX_BYTES) {
      throw new Error(`message resource too large: ${size} bytes`);
    }
      return downloadMessageResourceUncached(bot, messageId, fileKey, type, sourceType, chatId);
  })();

  messageResourceDownloads.set(cacheKey, task);
  try {
    return await task;
  } finally {
    messageResourceDownloads.delete(cacheKey);
  }
}

async function uploadImage(bot: FeishuBot, data: Buffer, fileName: string) {
  const token = await tenantAccessToken(bot);
  const form = new FormData();
  form.set('image_type', 'message');
  form.set('image', new Blob([new Uint8Array(data)]), fileName);
  const result = await feishuJson<{ data?: { image_key?: string } }>(`${openBase(bot.domain)}/open-apis/im/v1/images`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form
  });
  const imageKey = String(result.data?.image_key || '').trim();
  if (!imageKey) throw new Error('upload image failed: missing image_key');
  return imageKey;
}

async function ensureProcessedMediaDir() {
  await fs.mkdir(MESSAGE_RESOURCE_PROCESSED_DIR, { recursive: true });
}

function buildProcessedMediaFileNameWithExtension(
  fileKey: string,
  sourceType: 'image' | 'sticker',
  chatId: string,
  variant: MirroredImageVariant,
  extension: string,
  timestamp = Date.now()
) {
  const sourceMarker = sanitizeCacheSegment(sourceType, 'unknown');
  const chatMarker = sanitizeCacheSegment(chatId, 'unknown_chat');
  return `ts=${timestamp}--src=${sourceMarker}--chat=${chatMarker}--key=${sanitizeFileKeyForCache(fileKey)}--fx=mirror-${variant.axis}-${variant.sourceSide}${extension}`;
}

function randomMirrorVariant(): MirroredImageVariant {
  return {
    axis: Math.random() < 0.5 ? 'vertical' : 'horizontal',
    sourceSide: Math.random() < 0.5 ? 'start' : 'end'
  };
}

async function resolvePassiveMediaResource(bot: FeishuBot, messageId: string, chatId: string, parsedMessage: ParsedFeishuMessage): Promise<PassiveMediaResource | undefined> {
  if (parsedMessage.imageKey) {
    const resource = await downloadMessageResource(bot, messageId, parsedMessage.imageKey, 'image', 'image', chatId);
    return {
      sourceType: 'image',
      fileKey: parsedMessage.imageKey,
      resource
    };
  }
  if (!parsedMessage.stickerFileKey) return undefined;
  try {
    const resource = await downloadMessageResource(bot, messageId, parsedMessage.stickerFileKey, 'file', 'sticker', chatId);
    return {
      sourceType: 'sticker',
      fileKey: parsedMessage.stickerFileKey,
      resource
    };
  } catch (error) {
    console.warn('[feishu] passive sticker media resource is unavailable', {
      botId: bot.id,
      messageId,
      chatId,
      stickerFileKey: parsedMessage.stickerFileKey,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

async function buildMirroredImage(resource: PassiveMediaResource, chatId: string) {
  await ensureProcessedMediaDir();
  const variant = randomMirrorVariant();
  const outputExtension = extname(resource.resource.fileName) || guessExtensionFromContentType(resource.resource.contentType, '.png');
  const outputPath = join(MESSAGE_RESOURCE_PROCESSED_DIR, buildProcessedMediaFileNameWithExtension(resource.fileKey, resource.sourceType, chatId, variant, outputExtension));
  await execFileAsync('python3', [IMAGE_MIRROR_SCRIPT_PATH, resource.resource.filePath, outputPath, variant.axis, variant.sourceSide], { maxBuffer: 1024 * 1024 });
  return {
    variant,
    filePath: outputPath,
    fileName: basename(outputPath),
    data: await fs.readFile(outputPath)
  };
}

async function sendPassiveMediaRepeat(bot: FeishuBot, event: any, messageId: string, parsedMessage: ParsedFeishuMessage) {
  const chatId = messageChatId(event?.message);
  if (!chatId) return;

  const media = await resolvePassiveMediaResource(bot, messageId, chatId, parsedMessage);
  if (!media) return;

  if (media.sourceType === 'image') {
    const uploadedImageKey = await uploadImage(bot, media.resource.data, media.resource.fileName);
    await sendImageToChat(bot, chatId, uploadedImageKey);
    return;
  }

  await sendStickerToChat(bot, chatId, media.fileKey);
}

async function sendPassiveMediaReverse(bot: FeishuBot, event: any, messageId: string, parsedMessage: ParsedFeishuMessage) {
  const chatId = messageChatId(event?.message);
  if (!chatId) return;

  const media = await resolvePassiveMediaResource(bot, messageId, chatId, parsedMessage);
  if (!media) return;

  let transformed: { variant: MirroredImageVariant; filePath: string; fileName: string; data: Buffer } | undefined;
  try {
    transformed = await buildMirroredImage(media, chatId);
    const uploadedImageKey = await uploadImage(bot, transformed.data, transformed.fileName);
    await sendImageToChat(bot, chatId, uploadedImageKey);
  } finally {
    if (transformed?.filePath) {
      await fs.unlink(transformed.filePath).catch(() => undefined);
    }
  }
}

async function runPassiveInteractions(bot: FeishuBot, event: any, messageId: string, parsedMessage: ParsedFeishuMessage, history: RecentChatMessage[]) {
  const config = passiveInteractionConfig();
  const tasks: Array<Promise<void>> = [];
  const chatId = messageChatId(event?.message);
  const mentionsBot = messageMentionsBot(bot, event?.message);
  const text = parsedMessage.text;
  const reactionDecision = triggerDecision(config.reactionRate);
  const repeatDecision = triggerDecision(config.repeatRate);
  const imageRepeatDecision = triggerDecision(config.imageRepeatRate);
  const imitateDecision = triggerDecision(config.imitateRate);
  const reactionTriggered = config.reactionEmojis.length > 0 && reactionDecision.triggered;
  const repeatEligible = Boolean(text) && text.length <= config.repeatMaxChars;
  const repeatTriggered = repeatEligible && repeatDecision.triggered;
  const mediaRepeatEligible = Boolean(parsedMessage.imageKey || parsedMessage.stickerFileKey);
  const mediaRepeatTriggered = mediaRepeatEligible && imageRepeatDecision.triggered;
  const imageReverseTriggered = Boolean(parsedMessage.imageKey) && triggerDecision(config.imageReverseImageRate).triggered;
  const stickerReverseTriggered = Boolean(parsedMessage.stickerFileKey) && triggerDecision(config.imageReverseStickerRate).triggered;
  const byteStyleSetting = getStyleStickerSetting(
    bot.id,
    chatId,
    'byte_style',
    config.styleStickerDefaultMaxChars,
    config.styleStickerMaxCharsLimit
  );
  const scaleNewHeightsSetting = getStyleStickerSetting(
    bot.id,
    chatId,
    'scale_new_heights',
    config.styleStickerDefaultMaxChars,
    config.styleStickerMaxCharsLimit
  );
  const byteStyleTriggered = Boolean(text) && byteStyleSetting.enabled && text.length <= byteStyleSetting.maxChars && triggerDecision(config.byteStyleRate).triggered;
  const scaleNewHeightsTriggered = Boolean(text) && scaleNewHeightsSetting.enabled && text.length <= scaleNewHeightsSetting.maxChars && triggerDecision(config.scaleNewHeightsRate).triggered;
  const imitateEligible = !mentionsBot && Boolean(text);
  const imitateTriggered = imitateEligible && imitateDecision.triggered;

  if (reactionTriggered && isPassiveFeatureEnabled(bot.id, chatId, 'reaction')) {
    const emoji = randomItem(config.reactionEmojis);
    tasks.push(addReaction(bot, messageId, emoji));
  }

  if (mediaRepeatTriggered && isPassiveFeatureEnabled(bot.id, chatId, 'media_repeat')) {
    tasks.push(sendPassiveMediaRepeat(bot, event, messageId, parsedMessage));
  }

  if (imageReverseTriggered && isPassiveFeatureEnabled(bot.id, chatId, 'image_reverse')) {
    tasks.push(sendPassiveMediaReverse(bot, event, messageId, parsedMessage));
  }

  if (stickerReverseTriggered && isPassiveFeatureEnabled(bot.id, chatId, 'sticker_reverse')) {
    tasks.push(sendPassiveMediaReverse(bot, event, messageId, parsedMessage));
  }

  const repeatCandidate = repeatTriggered && isPassiveFeatureEnabled(bot.id, chatId, 'repeat');
  const styleStickerCandidates: StyleStickerFeature[] = [];
  if (byteStyleTriggered) styleStickerCandidates.push('byte_style');
  if (scaleNewHeightsTriggered) styleStickerCandidates.push('scale_new_heights');
  const exclusiveTextCandidates: Array<'repeat' | StyleStickerFeature> = [];
  if (repeatCandidate) exclusiveTextCandidates.push('repeat');
  exclusiveTextCandidates.push(...styleStickerCandidates);
  if (chatId && text && exclusiveTextCandidates.length > 0) {
    const selectedFeature = exclusiveTextCandidates.length === 1
      ? exclusiveTextCandidates[0]
      : randomItem(exclusiveTextCandidates);
    if (selectedFeature === 'repeat') {
      tasks.push(sendPassiveText(bot, event, messageId, text));
    } else {
      tasks.push(sendStyleStickerToChat(bot, chatId, selectedFeature, text));
    }
  }

  if (imitateTriggered && isPassiveFeatureEnabled(bot.id, chatId, 'llm_reply')) {
    tasks.push((async () => {
      const reply = await generateImitationReply(bot, event, text, history, config);
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
      hasCountFlag: false,
      shouldDelete: false,
      shouldSubscribe: false,
      shouldUnsubscribe: false,
      deleteAwemeId: '',
      hasInvalidCount: false,
      hasInvalidDelete: false,
      hasConflictingAction: false
    };
  }
  const argsText = text.slice(commandIndex + '/douyin'.length).trim();
  const hasDeleteFlag = /(?:^|\s)--delete(?:\s|$)/.test(argsText);
  const hasSubscribeFlag = /(?:^|\s)--subscribe(?:\s|$)/.test(argsText);
  const hasUnsubscribeFlag = /(?:^|\s)--unsubscribe(?:\s|$)/.test(argsText);
  const actionCount = [hasDeleteFlag, hasSubscribeFlag, hasUnsubscribeFlag].filter(Boolean).length;
  const deleteMatch = argsText.match(/(?:^|\s)--delete\s+(\S+)/);
  const deleteAwemeId = deleteMatch?.[1] || '';
  const hasInvalidDelete = hasDeleteFlag && !/^\d{6,}$/.test(deleteAwemeId);
  const hasCountFlag = /(?:^|\s)--count(?:\s|$)/.test(argsText);
  const countMatch = argsText.match(/(?:^|\s)--count\s+(\S+)/);
  const clickText = argsText
    .replace(/(?:^|\s)--delete(?:\s+\S+)?/, ' ')
    .replace(/(?:^|\s)--subscribe(?:\s|$)/, ' ')
    .replace(/(?:^|\s)--unsubscribe(?:\s|$)/, ' ')
    .replace(/(?:^|\s)--count(?:\s+\S+)?/, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!hasCountFlag) {
    return {
      isDouyin: true,
      clickText: actionCount > 0 ? clickText : argsText,
      count: 1,
      hasCountFlag,
      shouldDelete: hasDeleteFlag,
      shouldSubscribe: hasSubscribeFlag,
      shouldUnsubscribe: hasUnsubscribeFlag,
      deleteAwemeId,
      hasInvalidCount: false,
      hasInvalidDelete,
      hasConflictingAction: actionCount > 1
    };
  }
  if (!countMatch) {
    return {
      isDouyin: true,
      clickText,
      count: 1,
      hasCountFlag,
      shouldDelete: hasDeleteFlag,
      shouldSubscribe: hasSubscribeFlag,
      shouldUnsubscribe: hasUnsubscribeFlag,
      deleteAwemeId,
      hasInvalidCount: true,
      hasInvalidDelete,
      hasConflictingAction: actionCount > 1
    };
  }
  const count = Number(countMatch[1]);
  return {
    isDouyin: true,
    clickText,
    count: Number.isInteger(count) && count > 0 ? count : 1,
    hasCountFlag,
    shouldDelete: hasDeleteFlag,
    shouldSubscribe: hasSubscribeFlag,
    shouldUnsubscribe: hasUnsubscribeFlag,
    deleteAwemeId,
    hasInvalidCount: !Number.isInteger(count) || count <= 0,
    hasInvalidDelete,
    hasConflictingAction: actionCount > 1
  };
}

async function sendDouyinMessages(bot: FeishuBot, clickText: string, count: number, sendMessage: (text: string) => Promise<void>) {
  const awemeRecords = randomDouyinAwemeIds(bot.user_id!, clickText, count);
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

function isHelpCommand(text: string) {
  return /(?:^|\s)\/help(?:\s|$)/.test(text);
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

function parsePassiveToggleCommand(text: string): PassiveToggleCommand {
  const matches = PASSIVE_TOGGLE_COMMANDS
    .map((item) => ({ ...item, index: text.indexOf(item.command) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index);
  const match = matches[0];
  if (!match) return { isPassiveToggle: false };

  const args = text.slice(match.index + match.command.length).trim().split(/\s+/).filter(Boolean);
  const shouldEnable = args.includes('--enable');
  const shouldDisable = args.includes('--disable');
  return {
    isPassiveToggle: true,
    command: match.command,
    feature: match.feature,
    featureName: match.featureName,
    shouldEnable,
    shouldDisable,
    hasConflictingAction: shouldEnable && shouldDisable,
    hasUnknownArgs: args.some((arg) => arg !== '--enable' && arg !== '--disable')
  };
}

function parseStyleStickerCommand(text: string): StyleStickerCommand {
  const matches = STYLE_STICKER_COMMANDS
    .map((item) => ({ ...item, index: text.indexOf(item.command) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index);
  const match = matches[0];
  if (!match) return { isStyleSticker: false };

  let rest = text.slice(match.index + match.command.length).trim();
  let shouldEnable = false;
  let shouldDisable = false;
  let maxChars: number | undefined;
  let hasInvalidMax = false;

  while (rest) {
    if (/^--enable(?:\s|$)/.test(rest)) {
      shouldEnable = true;
      rest = rest.replace(/^--enable(?:\s+|$)/, '').trim();
      continue;
    }
    if (/^--disable(?:\s|$)/.test(rest)) {
      shouldDisable = true;
      rest = rest.replace(/^--disable(?:\s+|$)/, '').trim();
      continue;
    }
    if (/^--max(?:\s|$)/.test(rest)) {
      const next = rest.replace(/^--max(?:\s+|$)/, '').trim();
      if (!next) {
        hasInvalidMax = true;
        rest = '';
        break;
      }
      const token = readQuotedToken(next);
      const parsed = Number(token.token);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        hasInvalidMax = true;
      } else {
        maxChars = parsed;
      }
      rest = token.rest;
      continue;
    }
    break;
  }

  return {
    isStyleSticker: true,
    command: match.command,
    feature: match.feature,
    featureName: match.featureName,
    flavor: match.flavor,
    shouldEnable,
    shouldDisable,
    maxChars,
    hasConflictingAction: shouldEnable && shouldDisable,
    hasInvalidMax,
    text: unquoteCommand(rest)
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

function addDouyinSubscription(botId: number, chatId: string, clickText: string) {
  const result = db.prepare(`
    INSERT INTO feishu_douyin_subscriptions (bot_id, chat_id, click_text)
    VALUES (?, ?, ?)
    ON CONFLICT(bot_id, chat_id, click_text) DO UPDATE SET
      updated_at = CURRENT_TIMESTAMP
  `).run(botId, chatId, clickText);
  return { created: result.changes > 0 };
}

function removeDouyinSubscription(botId: number, chatId: string, clickText: string) {
  const result = db.prepare(`
    DELETE FROM feishu_douyin_subscriptions
    WHERE bot_id = ? AND chat_id = ? AND click_text = ?
  `).run(botId, chatId, clickText);
  return { deleted: result.changes };
}

function setPassiveFeatureEnabled(botId: number, chatId: string, feature: PassiveFeature, enabled: boolean) {
  db.prepare(`
    INSERT INTO feishu_chat_passive_settings (bot_id, chat_id, feature, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(bot_id, chat_id, feature) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = CURRENT_TIMESTAMP
  `).run(botId, chatId, feature, enabled ? 1 : 0);
}

function isPassiveFeatureEnabled(botId: number, chatId: string, feature: PassiveFeature) {
  if (!chatId) return feature === 'media_repeat' ? false : true;
  const row = db.prepare(`
    SELECT enabled
    FROM feishu_chat_passive_settings
    WHERE bot_id = ? AND chat_id = ? AND feature = ?
  `).get(botId, chatId, feature) as { enabled: number } | undefined;
  if (row) return row.enabled === 1;
  return feature === 'media_repeat' ? false : true;
}

function getStyleStickerSetting(
  botId: number,
  chatId: string,
  feature: StyleStickerFeature,
  defaultMaxChars: number,
  maxCharsLimit: number,
): StyleStickerChatSetting {
  if (!chatId) {
    const effectiveMaxChars = Math.min(defaultMaxChars, maxCharsLimit);
    return {
      enabled: false,
      maxChars: effectiveMaxChars,
      hasCustomMax: false,
      isCapped: effectiveMaxChars < defaultMaxChars
    };
  }
  const row = db.prepare(`
    SELECT enabled, max_chars
    FROM feishu_chat_style_sticker_settings
    WHERE bot_id = ? AND chat_id = ? AND feature = ?
  `).get(botId, chatId, feature) as { enabled: number; max_chars: number | null } | undefined;
  const customMax = row?.max_chars && row.max_chars > 0 ? row.max_chars : undefined;
  const configuredMaxChars = customMax || defaultMaxChars;
  const effectiveMaxChars = Math.min(configuredMaxChars, maxCharsLimit);
  return {
    enabled: row ? row.enabled === 1 : true,
    maxChars: effectiveMaxChars,
    hasCustomMax: Boolean(customMax),
    isCapped: effectiveMaxChars < configuredMaxChars
  };
}

function setStyleStickerSetting(
  botId: number,
  chatId: string,
  feature: StyleStickerFeature,
  updates: { enabled?: boolean; maxChars?: number }
) {
  const current = db.prepare(`
    SELECT enabled, max_chars
    FROM feishu_chat_style_sticker_settings
    WHERE bot_id = ? AND chat_id = ? AND feature = ?
  `).get(botId, chatId, feature) as { enabled: number; max_chars: number | null } | undefined;
  const enabled = updates.enabled ?? (current ? current.enabled === 1 : true);
  const maxChars = updates.maxChars ?? (current?.max_chars && current.max_chars > 0 ? current.max_chars : null);
  db.prepare(`
    INSERT INTO feishu_chat_style_sticker_settings (bot_id, chat_id, feature, enabled, max_chars)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bot_id, chat_id, feature) DO UPDATE SET
      enabled = excluded.enabled,
      max_chars = excluded.max_chars,
      updated_at = CURRENT_TIMESTAMP
  `).run(botId, chatId, feature, enabled ? 1 : 0, maxChars);
}

function styleStickerUsage(command: string) {
  return `用法：${command} 文案内容；或 ${command} --enable|--disable [--max 字符数]`;
}

function describeStyleStickerSetting(feature: StyleStickerFeature, setting: StyleStickerChatSetting) {
  return `当前会话${styleStickerFeatureName(feature)}随机生图已${setting.enabled ? '开启' : '关闭'}，最长处理字符数：${setting.maxChars}${setting.hasCustomMax ? '' : '（默认）'}${setting.isCapped ? '（受上限限制）' : ''}`;
}

function getDouyinSubscriptionsByUserAndClickText(userId: number, clickText: string) {
  return db.prepare(`
    SELECT s.id, s.bot_id, s.chat_id, s.click_text
    FROM feishu_douyin_subscriptions s
    INNER JOIN feishu_bots b ON b.id = s.bot_id
    WHERE b.user_id = ? AND b.enabled = 1 AND s.click_text = ?
    ORDER BY s.id ASC
  `).all(userId, clickText) as DouyinSubscriptionRecord[];
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

async function notifyDouyinSubscriptions(payload: { userId: number; clickText: string; awemeIds: string[] }) {
  if (!payload.clickText || payload.awemeIds.length === 0) return;
  const subscriptions = getDouyinSubscriptionsByUserAndClickText(payload.userId, payload.clickText);
  if (subscriptions.length === 0) return;

  for (const subscription of subscriptions) {
    const bot = getBot(subscription.bot_id);
    if (!bot || !bot.enabled) continue;

    for (const [index, awemeId] of payload.awemeIds.entries()) {
      try {
        await sendTextToChat(bot, subscription.chat_id, `https://www.douyin.com/video/${awemeId}`);
      } catch (error) {
        console.error('[feishu] douyin subscription send failed', {
          botId: bot.id,
          userId: payload.userId,
          chatId: subscription.chat_id,
          clickText: payload.clickText,
          awemeId,
          currentIndex: index + 1,
          totalCount: payload.awemeIds.length,
          error: error instanceof Error ? error.message : String(error)
        });
        break;
      }
      if (index < payload.awemeIds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
}

setDouyinAwemeNotifier(notifyDouyinSubscriptions);

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
  await sleep(CARD_REFERENCE_READY_DELAY_MS);
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
  const chatId = String(message?.chat_id || '').trim();
  if (isHelpCommand(text)) {
    await replyHelpCard(bot, messageId);
    return true;
  }
  if (options.allowSetDefault) {
    const addCron = parseAddCronCommand(text);
    if (addCron.isAddCron) {
      if (!addCron.cronExpr) {
        await replyText(bot, messageId, '用法：/add-cron "*/5 * * * *" "/douyin 123 [--count n]"；如果已设置 /set-default，也可以省略第二个参数');
        return true;
      }
      const commandText = addCron.commandText || getDefaultCommand(bot.id);
      if (!commandText) {
        await replyText(bot, messageId, '用法：/add-cron "*/5 * * * *" "/douyin 123 [--count n]"；当前机器人未设置 /set-default，不能省略第二个参数');
        return true;
      }
      if (!chatId) {
        await replyText(bot, messageId, '当前消息缺少 chat_id，无法创建会话定时任务');
        return true;
      }
      try {
        const task = addCronTask(bot.id, chatId, addCron.cronExpr, commandText);
        await replyText(bot, messageId, `已添加定时任务 #${task.id}，下次执行：${task.nextRunAt}\n${addCron.cronExpr} -> ${commandText}`);
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
  const passiveToggle = parsePassiveToggleCommand(text);
  const styleStickerCommand = parseStyleStickerCommand(text);
  if (styleStickerCommand.isStyleSticker) {
    const hasSettingUpdates =
      styleStickerCommand.shouldEnable ||
      styleStickerCommand.shouldDisable ||
      styleStickerCommand.maxChars !== undefined;
    if (styleStickerCommand.hasConflictingAction || styleStickerCommand.hasInvalidMax) {
      await replyText(bot, messageId, styleStickerUsage(styleStickerCommand.command));
      return true;
    }
    if (!chatId) {
      await replyText(bot, messageId, '当前消息缺少 chat_id，无法发送贴纸图片或设置当前会话随机生图');
      return true;
    }
    if (!styleStickerCommand.text && !hasSettingUpdates) {
      try {
        await replyStyleStickerGeneratorCard(bot, messageId, styleStickerCommand.feature);
      } catch (error) {
        await replyText(
          bot,
          messageId,
          error instanceof Error ? `${styleStickerCommand.featureName}卡片生成失败：${error.message}` : `${styleStickerCommand.featureName}卡片生成失败`
        );
      }
      return true;
    }

    if (hasSettingUpdates) {
      setStyleStickerSetting(bot.id, chatId, styleStickerCommand.feature, {
        enabled: styleStickerCommand.shouldEnable ? true : styleStickerCommand.shouldDisable ? false : undefined,
        maxChars: styleStickerCommand.maxChars
      });
    }

    if (styleStickerCommand.text) {
      try {
        await sendStyleStickerToChat(bot, chatId, styleStickerCommand.feature, styleStickerCommand.text);
      } catch (error) {
        await replyText(
          bot,
          messageId,
          error instanceof Error ? `${styleStickerCommand.featureName}生图失败：${error.message}` : `${styleStickerCommand.featureName}生图失败`
        );
        return true;
      }
      if (hasSettingUpdates) {
        const config = passiveInteractionConfig();
        const setting = getStyleStickerSetting(
          bot.id,
          chatId,
          styleStickerCommand.feature,
          config.styleStickerDefaultMaxChars,
          config.styleStickerMaxCharsLimit
        );
        await replyText(bot, messageId, describeStyleStickerSetting(styleStickerCommand.feature, setting));
      }
      return true;
    }

    const config = passiveInteractionConfig();
    const setting = getStyleStickerSetting(
      bot.id,
      chatId,
      styleStickerCommand.feature,
      config.styleStickerDefaultMaxChars,
      config.styleStickerMaxCharsLimit
    );
    await replyText(bot, messageId, describeStyleStickerSetting(styleStickerCommand.feature, setting));
    return true;
  }
  if (passiveToggle.isPassiveToggle) {
    if (passiveToggle.hasConflictingAction || passiveToggle.hasUnknownArgs || (!passiveToggle.shouldEnable && !passiveToggle.shouldDisable)) {
      await replyText(bot, messageId, `用法：${passiveToggle.command} --enable 或 ${passiveToggle.command} --disable`);
      return true;
    }
    if (!chatId) {
      await replyText(bot, messageId, '当前消息缺少 chat_id，无法设置当前会话的被动交互开关');
      return true;
    }
    const enabled = passiveToggle.shouldEnable;
    setPassiveFeatureEnabled(bot.id, chatId, passiveToggle.feature, enabled);
    await replyText(bot, messageId, `当前会话已${enabled ? '开启' : '关闭'}${passiveToggle.featureName}`);
    return true;
  }

  const douyinCommand = parseDouyinCommand(text);
  if (douyinCommand.isDouyin) {
    if (douyinCommand.hasConflictingAction) {
      await replyText(bot, messageId, '用法冲突：/douyin 同时只能使用一种动作参数（--delete、--subscribe、--unsubscribe）。常用：/douyin {模拟点击文案} [--count n]；/douyin --subscribe {模拟点击文案}');
      return true;
    }
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
    if (douyinCommand.shouldSubscribe) {
      if (!douyinCommand.clickText) {
        await replyText(bot, messageId, '用法：/douyin --subscribe {模拟点击文案}。订阅的是该文案对应的 clickText 分组，例如 /douyin --subscribe 随机甜妹');
        return true;
      }
      if (douyinCommand.hasCountFlag) {
        await replyText(bot, messageId, '订阅模式不支持 --count；订阅只监听该 clickText 分组后续新增入库记录，请使用 /douyin --subscribe {模拟点击文案}');
        return true;
      }
      if (!chatId) {
        await replyText(bot, messageId, '当前消息缺少 chat_id，无法订阅抖音更新');
        return true;
      }
      if (bot.user_id == null) {
        await replyText(bot, messageId, '当前机器人未绑定用户，无法订阅抖音更新');
        return true;
      }
      addDouyinSubscription(bot.id, chatId, douyinCommand.clickText);
      await replyText(bot, messageId, `已订阅当前会话的“${douyinCommand.clickText}”更新（按 clickText 分组）。后续桌面端同步时，只有该分组有新的 aweme_id 成功入库才会自动发送；已有记录不会补发。`);
      return true;
    }
    if (douyinCommand.shouldUnsubscribe) {
      if (!douyinCommand.clickText) {
        await replyText(bot, messageId, '用法：/douyin --unsubscribe {模拟点击文案}。取消的是当前会话对该 clickText 分组的订阅。');
        return true;
      }
      if (douyinCommand.hasCountFlag) {
        await replyText(bot, messageId, '取消订阅模式不支持 --count，请使用 /douyin --unsubscribe {模拟点击文案}');
        return true;
      }
      if (!chatId) {
        await replyText(bot, messageId, '当前消息缺少 chat_id，无法取消订阅抖音更新');
        return true;
      }
      const result = removeDouyinSubscription(bot.id, chatId, douyinCommand.clickText);
      if (result.deleted === 0) {
        await replyText(bot, messageId, `当前会话未订阅“${douyinCommand.clickText}”这个 clickText 分组`);
        return true;
      }
      await replyText(bot, messageId, `已取消当前会话对“${douyinCommand.clickText}”这个 clickText 分组的订阅`);
      return true;
    }
    if (!douyinCommand.clickText) {
      await replyText(bot, messageId, '用法：/douyin {模拟点击文案} [--count n]；订阅新增记录：/douyin --subscribe {模拟点击文案}；取消订阅：/douyin --unsubscribe {模拟点击文案}');
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
  if (text) rememberRecentChatMessage(bot, event, text);

  if (shouldHandleCommand && text) {
    if (await handleFeishuCommand(bot, event, messageId, text, { allowSetDefault: true })) {
      return;
    }

    const defaultCommand = getDefaultCommand(bot.id);
    if (defaultCommand) {
      if (await handleFeishuCommand(bot, event, messageId, defaultCommand, { allowSetDefault: false })) {
        return;
      }
      await replyText(bot, messageId, defaultCommand);
      return;
    }
  }

  await runPassiveInteractions(bot, event, messageId, parsedMessage, history);
}

function getOwnedBot(id: number, userId: number) {
  return db.prepare('SELECT * FROM feishu_bots WHERE id = ? AND user_id = ?').get(id, userId) as FeishuBot | undefined;
}

export function listFeishuBots(req: AuthenticatedRequest, res: ExpressResponse) {
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

export function createFeishuBot(req: AuthenticatedRequest, res: ExpressResponse) {
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
  db.prepare('DELETE FROM feishu_douyin_subscriptions WHERE bot_id = ?').run(botId);
  db.prepare('DELETE FROM feishu_chat_passive_settings WHERE bot_id = ?').run(botId);
  db.prepare('DELETE FROM feishu_bots WHERE id = ? AND user_id = ?').run(botId, userId);
  tokenCache.delete(botId);
  return true;
}

export function deleteFeishuBot(req: AuthenticatedRequest, res: ExpressResponse) {
  const botId = Number(req.params.id);
  if (!req.user || !deleteOwnedFeishuBot(botId, req.user.id)) {
    res.status(404).json({ error: 'bot not found' });
    return;
  }
  res.status(204).end();
}

export async function probeFeishuBot(req: AuthenticatedRequest, res: ExpressResponse) {
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

export async function feishuWebhook(req: Request, res: ExpressResponse) {
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
    handleFeishuMessage(bot, payload.event).catch((error) => {
      console.error('[feishu] message handling failed', {
        botId: bot.id,
        messageId,
        eventId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  if (eventType === 'card.action.trigger') {
    const eventId = String(payload.header?.event_id || '').trim();
    const messageId = String(payload.event?.context?.open_message_id || '').trim();
    handleFeishuCardAction(bot, payload).catch((error) => {
      console.error('[feishu] card action handling failed', {
        botId: bot.id,
        messageId,
        eventId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    res.json({ toast: { type: 'info', content: '正在生成，请稍等' } });
    return;
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
