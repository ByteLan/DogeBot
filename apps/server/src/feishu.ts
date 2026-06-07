import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { db } from './db.js';
import { randomDouyinAwemeId } from './douyin.js';

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
};

function openBase(domain: string) {
  return FEISHU_BASE[domain] || FEISHU_BASE.feishu;
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
  await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) })
  });
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
  if (commandIndex < 0) return { isDouyin: false, clickText: '' };
  return {
    isDouyin: true,
    clickText: text.slice(commandIndex + '/douyin'.length).trim()
  };
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

function usersCard(records: AtRecord[]) {
  const atTexts = records.map((record) => `<at id=${record.at_who}></at>`);
  const groups: string[] = [];
  for (let index = 0; index < atTexts.length; index += 100) {
    groups.push(atTexts.slice(index, index + 100).join(' '));
  }
  const content = groups.length > 0 ? groups.join('\n\n') : '暂无已记录用户';
  const elements: object[] = [{ tag: 'markdown', content }];
  if (records.length > 0) {
    elements.push({
      tag: 'person_list',
      drop_invalid_user_id: true,
      show_avatar: true,
      size: 'large',
      persons: records.map((record) => ({ id: record.at_who }))
    });
  }
  return {
    schema: '2.0',
    body: { elements }
  };
}

export async function handleFeishuMessage(bot: FeishuBot, event: any) {
  const message = event?.message;
  const messageId = message?.message_id;
  const text = textFromMessage(message);
  if (!messageId || !text) return;

  const douyinCommand = parseDouyinCommand(text);
  if (douyinCommand.isDouyin) {
    if (!douyinCommand.clickText) {
      await replyText(bot, messageId, '用法：/douyin {模拟点击文案}');
      return;
    }
    if (bot.user_id == null) {
      await replyText(bot, messageId, '当前机器人未绑定用户，无法读取抖音收藏记录');
      return;
    }
    const awemeId = randomDouyinAwemeId(bot.user_id, douyinCommand.clickText);
    await replyText(bot, messageId, awemeId ? `https://www.douyin.com/video/${awemeId}` : `暂无“${douyinCommand.clickText}”的抖音收藏记录`);
    return;
  }

  const command = parseUsersCommand(text);
  if (!command.isUsers) {
    await replyText(bot, messageId, text);
    return;
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

  await replyCard(bot, messageId, usersCard(listMentions(bot.id, atBy.id, command.newCount)));
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
    handleFeishuMessage(bot, payload.event).catch((error) => console.error('[feishu] message handling failed', error));
  }

  res.json({ ok: true });
}
