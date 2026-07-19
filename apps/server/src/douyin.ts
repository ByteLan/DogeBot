import type { Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import type { FeishuBot } from './types.js';
import { db } from './db.js';
import { checkDouyinAwemeValidity, INVALID_TITLE_MARKER, type DouyinValidity } from './douyin-check.js';

type DouyinAwemeRecord = {
  aweme_id: string;
};

type DouyinAwemeSaveResult = {
  inserted: number;
  total: number;
  insertedAwemeIds: string[];
};

type DouyinAwemeNotifier = (payload: { userId: number; clickText: string; awemeIds: string[] }) => Promise<void>;

const ACTIVE_DOUYIN_RECORD_FILTER = "COALESCE(status, '') <> 'delete'";
let douyinAwemeNotifier: DouyinAwemeNotifier | undefined;

function normalizeClickText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAwemeIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = String(item || '').trim();
    if (/^\d+$/.test(id)) seen.add(id);
  }
  return [...seen];
}

export function saveDouyinAwemeRecords(userId: number, clickText: string, awemeIds: string[]): DouyinAwemeSaveResult {
  if (!clickText || awemeIds.length === 0) return { inserted: 0, total: 0, insertedAwemeIds: [] };
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO douyin_aweme_records (user_id, click_text, aweme_id)
    VALUES (?, ?, ?)
  `);
  const tx = db.transaction((ids: string[]) => {
    const insertedAwemeIds: string[] = [];
    for (const awemeId of ids) {
      const result = stmt.run(userId, clickText, awemeId);
      if (result.changes > 0) insertedAwemeIds.push(awemeId);
    }
    return insertedAwemeIds;
  });
  const insertedAwemeIds = tx(awemeIds) as string[];
  const total = (db.prepare(`
    SELECT COUNT(*) AS value
    FROM douyin_aweme_records
    WHERE user_id = ? AND click_text = ? AND ${ACTIVE_DOUYIN_RECORD_FILTER}
  `).get(userId, clickText) as { value: number }).value;
  return { inserted: insertedAwemeIds.length, total, insertedAwemeIds };
}

export function setDouyinAwemeNotifier(notifier: DouyinAwemeNotifier | undefined) {
  douyinAwemeNotifier = notifier;
}

export async function uploadDouyinAwemeRecords(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const clickText = normalizeClickText(req.body?.clickText);
  const awemeIds = normalizeAwemeIds(req.body?.awemeIds);
  if (!clickText) {
    res.status(400).json({ error: 'clickText is required' });
    return;
  }
  if (awemeIds.length === 0) {
    res.status(400).json({ error: 'awemeIds is required' });
    return;
  }
  const result = saveDouyinAwemeRecords(req.user.id, clickText, awemeIds);
  if (result.insertedAwemeIds.length > 0 && douyinAwemeNotifier) {
    try {
      await douyinAwemeNotifier({ userId: req.user.id, clickText, awemeIds: result.insertedAwemeIds });
    } catch (error) {
      console.error('[douyin] notify subscribers failed', {
        userId: req.user.id,
        clickText,
        inserted: result.insertedAwemeIds.length,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  res.json(result);
}

export function randomDouyinAwemeId(userId: number, clickText: string) {
  const row = db.prepare(`
    SELECT aweme_id
    FROM douyin_aweme_records
    WHERE user_id = ? AND click_text = ? AND ${ACTIVE_DOUYIN_RECORD_FILTER}
    ORDER BY RANDOM()
    LIMIT 1
  `).get(userId, clickText) as DouyinAwemeRecord | undefined;
  return row?.aweme_id || '';
}

export function randomDouyinAwemeIds(userId: number, clickText: string, count: number) {
  if (!Number.isInteger(count) || count <= 0) return [];
  return db.prepare(`
    SELECT aweme_id
    FROM douyin_aweme_records
    WHERE user_id = ? AND click_text = ? AND ${ACTIVE_DOUYIN_RECORD_FILTER}
    ORDER BY RANDOM()
    LIMIT ?
  `).all(userId, clickText, count) as DouyinAwemeRecord[];
}

export function randomDouyinAwemeIdExcluding(userId: number, clickText: string, excludeIds: string[]) {
  const normalizedExcludes = [...new Set(excludeIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (normalizedExcludes.length === 0) return randomDouyinAwemeId(userId, clickText);
  const placeholders = normalizedExcludes.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT aweme_id
    FROM douyin_aweme_records
    WHERE user_id = ? AND click_text = ? AND ${ACTIVE_DOUYIN_RECORD_FILTER}
      AND aweme_id NOT IN (${placeholders})
    ORDER BY RANDOM()
    LIMIT 1
  `).get(userId, clickText, ...normalizedExcludes) as DouyinAwemeRecord | undefined;
  return row?.aweme_id || '';
}

export function findDouyinRecordByAwemeId(userId: number, awemeId: string) {
  return db.prepare(`
    SELECT click_text, status
    FROM douyin_aweme_records
    WHERE user_id = ? AND aweme_id = ?
    LIMIT 1
  `).get(userId, awemeId) as { click_text: string; status: string } | undefined;
}

export function randomDouyinAwemeIdByClickText(clickText: string) {
  const row = db.prepare(`
    SELECT aweme_id
    FROM douyin_aweme_records
    WHERE click_text = ? AND ${ACTIVE_DOUYIN_RECORD_FILTER}
    ORDER BY RANDOM()
    LIMIT 1
  `).get(clickText) as DouyinAwemeRecord | undefined;
  return row?.aweme_id || '';
}

export function randomDouyinAwemeIdByClickTextExcluding(clickText: string, excludeIds: string[]) {
  const normalizedExcludes = [...new Set(excludeIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (normalizedExcludes.length === 0) return randomDouyinAwemeIdByClickText(clickText);
  const placeholders = normalizedExcludes.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT aweme_id
    FROM douyin_aweme_records
    WHERE click_text = ? AND ${ACTIVE_DOUYIN_RECORD_FILTER}
      AND aweme_id NOT IN (${placeholders})
    ORDER BY RANDOM()
    LIMIT 1
  `).get(clickText, ...normalizedExcludes) as DouyinAwemeRecord | undefined;
  return row?.aweme_id || '';
}

const CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCheckCache(awemeId: string) {
  const row = db.prepare(`
    SELECT last_checked_at, last_checked_title
    FROM douyin_aweme_records
    WHERE aweme_id = ? AND ${ACTIVE_DOUYIN_RECORD_FILTER}
    LIMIT 1
  `).get(awemeId) as { last_checked_at: string | null; last_checked_title: string } | undefined;
  if (!row?.last_checked_at) return null;
  const checkedAt = new Date(row.last_checked_at).getTime();
  if (Date.now() - checkedAt > CHECK_CACHE_TTL_MS) return null;
  return { title: row.last_checked_title, checkedAt };
}

function saveCheckCache(awemeId: string, title: string) {
  db.prepare(`
    UPDATE douyin_aweme_records
    SET last_checked_at = CURRENT_TIMESTAMP, last_checked_title = ?, updated_at = CURRENT_TIMESTAMP
    WHERE aweme_id = ? AND ${ACTIVE_DOUYIN_RECORD_FILTER}
  `).run(title, awemeId);
}

export async function checkDouyinAwemeValidityCached(awemeId: string, skipCache = false): Promise<DouyinValidity> {
  if (!skipCache) {
    const cached = getCheckCache(awemeId);
    if (cached) {
      const invalid = cached.title.startsWith(INVALID_TITLE_MARKER);
      return { awemeId, valid: !invalid, title: cached.title, errored: false };
    }
  }
  const result = await checkDouyinAwemeValidity(awemeId);
  if (!result.errored) {
    saveCheckCache(awemeId, result.title);
  }
  return result;
}

export function softDeleteDouyinAwemeRecords(userId: number, awemeId: string) {
  const matched = (db.prepare(`
    SELECT COUNT(*) AS value
    FROM douyin_aweme_records
    WHERE user_id = ? AND aweme_id = ?
  `).get(userId, awemeId) as { value: number }).value;
  const result = db.prepare(`
    UPDATE douyin_aweme_records
    SET status = 'delete', deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND aweme_id = ? AND ${ACTIVE_DOUYIN_RECORD_FILTER}
  `).run(userId, awemeId);
  return { matched, deleted: result.changes };
}

export function restoreDouyinAwemeRecords(userId: number, awemeId: string) {
  const matched = (db.prepare(`
    SELECT COUNT(*) AS value
    FROM douyin_aweme_records
    WHERE user_id = ? AND aweme_id = ?
  `).get(userId, awemeId) as { value: number }).value;
  const result = db.prepare(`
    UPDATE douyin_aweme_records
    SET status = '', deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND aweme_id = ? AND status = 'delete'
  `).run(userId, awemeId);
  return { matched, restored: result.changes };
}

const OPEN_API_MAX_ATTEMPTS = 3;
const OPEN_API_BOT_ID = 1;

function getOpenApiBot(): FeishuBot | undefined {
  return db.prepare('SELECT * FROM feishu_bots WHERE id = ?').get(OPEN_API_BOT_ID) as FeishuBot | undefined;
}

function getOpenApiAdminUserId(): string {
  const row = db.prepare('SELECT admin_user_id FROM feishu_bot_default_commands WHERE bot_id = ?')
    .get(OPEN_API_BOT_ID) as { admin_user_id: string | null } | undefined;
  return row?.admin_user_id?.trim() || '';
}

function findRecordOwnerUserId(awemeId: string): number | null {
  const row = db.prepare(`
    SELECT user_id FROM douyin_aweme_records WHERE aweme_id = ? AND ${ACTIVE_DOUYIN_RECORD_FILTER} LIMIT 1
  `).get(awemeId) as { user_id: number } | undefined;
  return row?.user_id ?? null;
}

let notifyAdminDouyinInvalidFn: ((bot: FeishuBot, context: any) => Promise<void>) | undefined;

export function setOpenApiInvalidNotifier(fn: (bot: FeishuBot, context: any) => Promise<void>) {
  notifyAdminDouyinInvalidFn = fn;
}

async function notifyOpenApiAdmin(awemeId: string, title: string) {
  if (!notifyAdminDouyinInvalidFn) return;
  const bot = getOpenApiBot();
  if (!bot) return;
  const adminUserId = getOpenApiAdminUserId();
  if (!adminUserId) return;
  const userId = findRecordOwnerUserId(awemeId);
  if (userId == null) return;
  try {
    await notifyAdminDouyinInvalidFn(bot, {
      awemeId,
      userId,
      adminUserId,
      title,
      triggerChatId: '',
      triggerPersonId: 'open-api',
      triggerPersonName: 'Open API',
      source: 'open-api 自动检测'
    });
  } catch (error) {
    console.error('[douyin] open-api admin notify failed', {
      awemeId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function resolveValidAwemeIdForOpenApi(clickText: string): Promise<{ awemeId: string; title: string }> {
  const attempted: string[] = [];
  let lastTitle = '';
  for (let i = 0; i < OPEN_API_MAX_ATTEMPTS; i++) {
    const awemeId = randomDouyinAwemeIdByClickTextExcluding(clickText, attempted);
    if (!awemeId) break;
    attempted.push(awemeId);
    const validity = await checkDouyinAwemeValidityCached(awemeId);
    lastTitle = validity.title;
    if (validity.valid || validity.errored) return { awemeId, title: validity.title };
    await notifyOpenApiAdmin(awemeId, validity.title);
  }
  return { awemeId: attempted[attempted.length - 1] || '', title: lastTitle };
}

export async function getRandomMmVideo(_req: AuthenticatedRequest, res: Response) {
  const { awemeId, title } = await resolveValidAwemeIdForOpenApi('随机甜妹');
  if (!awemeId) {
    res.status(404).json({ error: 'no aweme found' });
    return;
  }
  res.json({
    data: {
      url: `https://www.douyin.com/video/${awemeId}`,
      title
    }
  });
}

export async function redirectRandomMmVideo(_req: AuthenticatedRequest, res: Response) {
  const { awemeId } = await resolveValidAwemeIdForOpenApi('随机甜妹');
  if (!awemeId) {
    res.status(404).json({ error: 'no aweme found' });
    return;
  }
  res.redirect(`https://www.douyin.com/video/${awemeId}`);
}
