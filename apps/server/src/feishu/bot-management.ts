import type { Request, Response as ExpressResponse } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import type { FeishuBot } from '../types.js';
import { db } from '../db.js';
import { clearTokenCache, tenantAccessToken } from './client.js';
import { feishuJson, openBase } from './client.js';

export function getBot(id: number) {
  return db.prepare('SELECT * FROM feishu_bots WHERE id = ?').get(id) as FeishuBot | undefined;
}

export function getEnabledBots() {
  return db.prepare('SELECT * FROM feishu_bots WHERE enabled = 1 AND user_id IS NOT NULL ORDER BY id ASC').all() as FeishuBot[];
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
  db.prepare('DELETE FROM feishu_chat_fallback_mention_settings WHERE bot_id = ?').run(botId);
  db.prepare('DELETE FROM feishu_chat_passive_settings WHERE bot_id = ?').run(botId);
  db.prepare('DELETE FROM feishu_chat_style_sticker_settings WHERE bot_id = ?').run(botId);
  db.prepare('DELETE FROM feishu_bots WHERE id = ? AND user_id = ?').run(botId, userId);
  clearTokenCache(botId);
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
