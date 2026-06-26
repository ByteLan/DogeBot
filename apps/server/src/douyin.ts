import type { Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { db } from './db.js';

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

export function getRandomMmVideo(_req: AuthenticatedRequest, res: Response) {
  const awemeId = randomDouyinAwemeIdByClickText('随机甜妹');
  if (!awemeId) {
    res.status(404).json({ error: 'no aweme found' });
    return;
  }
  res.json({
    data: {
      url: `https://www.douyin.com/video/${awemeId}`
    }
  });
}

export function redirectRandomMmVideo(_req: AuthenticatedRequest, res: Response) {
  const awemeId = randomDouyinAwemeIdByClickText('随机甜妹');
  if (!awemeId) {
    res.status(404).json({ error: 'no aweme found' });
    return;
  }
  res.redirect(`https://www.douyin.com/video/${awemeId}`);
}
