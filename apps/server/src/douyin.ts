import type { Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { db } from './db.js';

type DouyinAwemeRecord = {
  aweme_id: string;
};

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

export function saveDouyinAwemeRecords(userId: number, clickText: string, awemeIds: string[]) {
  if (!clickText || awemeIds.length === 0) return { inserted: 0, total: 0 };
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO douyin_aweme_records (user_id, click_text, aweme_id)
    VALUES (?, ?, ?)
  `);
  const tx = db.transaction((ids: string[]) => ids.reduce((inserted, awemeId) => inserted + stmt.run(userId, clickText, awemeId).changes, 0));
  const inserted = tx(awemeIds) as number;
  const total = (db.prepare(`
    SELECT COUNT(*) AS value
    FROM douyin_aweme_records
    WHERE user_id = ? AND click_text = ?
  `).get(userId, clickText) as { value: number }).value;
  return { inserted, total };
}

export function uploadDouyinAwemeRecords(req: AuthenticatedRequest, res: Response) {
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
  res.json(saveDouyinAwemeRecords(req.user.id, clickText, awemeIds));
}

export function randomDouyinAwemeId(userId: number, clickText: string) {
  const row = db.prepare(`
    SELECT aweme_id
    FROM douyin_aweme_records
    WHERE user_id = ? AND click_text = ?
    ORDER BY RANDOM()
    LIMIT 1
  `).get(userId, clickText) as DouyinAwemeRecord | undefined;
  return row?.aweme_id || '';
}

export function randomDouyinAwemeIdByClickText(clickText: string) {
  const row = db.prepare(`
    SELECT aweme_id
    FROM douyin_aweme_records
    WHERE click_text = ?
    ORDER BY RANDOM()
    LIMIT 1
  `).get(clickText) as DouyinAwemeRecord | undefined;
  return row?.aweme_id || '';
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
