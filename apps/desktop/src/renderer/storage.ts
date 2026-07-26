import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { defaultFavoriteUrl, defaultCollectListUrl, defaultRequestUrlFilter } from '../shared/constants';
import type { DouyinTask } from './types';

export const initialServerUrl = localStorage.getItem('dogebot.serverUrl') || 'http://127.0.0.1:3000';

export function readPositiveNumber(key: string, fallback: number) {
  const parsed = Number(localStorage.getItem(key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createTaskId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultTask(partial: Partial<DouyinTask> = {}): DouyinTask {
  return {
    id: partial.id || createTaskId(),
    enabled: partial.enabled ?? true,
    favoriteUrl: partial.favoriteUrl || defaultFavoriteUrl,
    collectListUrl: partial.collectListUrl || defaultCollectListUrl,
    requestUrlFilter: partial.requestUrlFilter || defaultRequestUrlFilter,
    clickText: partial.clickText || '',
    skipClick: partial.skipClick ?? false
  };
}

export function normalizeStoredTask(value: unknown): DouyinTask | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return createDefaultTask({
    id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : createTaskId(),
    enabled: record.enabled !== false,
    favoriteUrl: typeof record.favoriteUrl === 'string' && record.favoriteUrl.trim() ? record.favoriteUrl.trim() : defaultFavoriteUrl,
    collectListUrl: typeof record.collectListUrl === 'string' && record.collectListUrl.trim() ? record.collectListUrl.trim() : defaultCollectListUrl,
    requestUrlFilter: typeof record.requestUrlFilter === 'string' && record.requestUrlFilter.trim()
      ? record.requestUrlFilter.trim()
      : typeof record.collectsId === 'string' && record.collectsId.trim()
        ? record.collectsId.trim()
        : defaultRequestUrlFilter,
    clickText: typeof record.clickText === 'string' ? record.clickText.trim() : '',
    skipClick: Boolean(record.skipClick)
  });
}

export function readStoredTasks() {
  const stored = localStorage.getItem('dogebot.douyinTasks');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        const tasks = parsed.map(normalizeStoredTask).filter(Boolean) as DouyinTask[];
        if (tasks.length > 0) return tasks;
      }
    } catch {
      // ignore malformed storage
    }
  }
  const legacyClickText = localStorage.getItem('dogebot.douyinClickText') || '';
  const legacyCollectsId = localStorage.getItem('dogebot.douyinCollectsId') || '';
  const legacySkipClick = localStorage.getItem('dogebot.douyinSkipClick') === '1';
  if (legacyClickText || legacyCollectsId) {
    return [createDefaultTask({ clickText: legacyClickText, requestUrlFilter: legacyCollectsId, skipClick: legacySkipClick })];
  }
  return [createDefaultTask()];
}

export function readStoredStringList(key: string, fallback: string[] = []) {
  const stored = localStorage.getItem(key);
  if (!stored) return fallback;
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return fallback;
    return parsed.flatMap((item) => {
      const value = typeof item === 'string' ? item.trim() : '';
      return value ? [value] : [];
    });
  } catch {
    return fallback;
  }
}

// 复刻原先「useState 惰性初始化 + useEffect 写回」的持久化模式：
// 首次渲染用 load() 读取初值，value 变化（含挂载）时调用 persist(value) 写入 localStorage。
export function usePersistentState<T>(load: () => T, persist: (value: T) => void): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(load);
  useEffect(() => {
    persist(value);
  }, [value]);
  return [value, setValue];
}
