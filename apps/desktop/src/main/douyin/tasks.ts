import { isValidHttpUrl, normalizeCollectListBaseUrl } from '../../shared/url.js';
import type { DouyinTaskConfig } from '../../shared/types.js';

export function normalizeUrl(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function taskLabel(task: DouyinTaskConfig) {
  return task.clickText || task.requestUrlFilter || task.id;
}

export function normalizeDouyinTask(task: unknown): DouyinTaskConfig | undefined {
  if (!task || typeof task !== 'object') return undefined;
  const record = task as Record<string, unknown>;
  const normalized: DouyinTaskConfig = {
    id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `task-${Date.now()}`,
    favoriteUrl: normalizeUrl(record.favoriteUrl),
    collectListUrl: normalizeUrl(record.collectListUrl),
    requestUrlFilter: typeof record.requestUrlFilter === 'string'
      ? record.requestUrlFilter.trim()
      : typeof record.collectsId === 'string'
        ? record.collectsId.trim()
        : '',
    clickText: typeof record.clickText === 'string' ? record.clickText.trim() : '',
    skipClick: Boolean(record.skipClick)
  };
  if (!normalized.favoriteUrl || !normalized.collectListUrl || !normalized.requestUrlFilter || !normalized.clickText) return undefined;
  if (!isValidHttpUrl(normalized.favoriteUrl) || !isValidHttpUrl(normalized.collectListUrl)) return undefined;
  return normalized;
}

export function isCollectListUrl(url: string, task: DouyinTaskConfig) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}` === normalizeCollectListBaseUrl(task.collectListUrl)
      && url.includes(task.requestUrlFilter);
  } catch {
    return false;
  }
}

export function toPositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
