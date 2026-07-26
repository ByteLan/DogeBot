import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { defaultFavoriteUrl, defaultCollectListUrl, defaultRequestUrlFilter } from '../shared/constants';
import type { DouyinPartition, DouyinTask } from './types';

export const initialServerUrl = localStorage.getItem('dogebot.serverUrl') || 'http://127.0.0.1:3000';

// 内置默认 partition：其 electron partition 串沿用旧的 persist:dogebot-douyin，
// 保证历史登录态不丢；其余 partition 由 id 派生。
export const DEFAULT_PARTITION_ID = 'default';
export const DEFAULT_PARTITION_ELECTRON = 'persist:dogebot-douyin';

export function partitionElectronId(partitionId: string) {
  return partitionId === DEFAULT_PARTITION_ID ? DEFAULT_PARTITION_ELECTRON : `persist:dogebot-douyin-${partitionId}`;
}

export function readPositiveNumber(key: string, fallback: number) {
  const parsed = Number(localStorage.getItem(key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createTaskId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createPartitionId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

// 新任务默认值 = 顶部全局配置（若无则回落到内置默认）。migrate 旧任务时同样借此
// 让缺失的每任务字段回落到旧全局配置，保证单任务行为逐字不变。
function readGlobalTaskDefaults() {
  return {
    runHidden: localStorage.getItem('dogebot.douyinRunHidden') === '1',
    showOnClickFailure: localStorage.getItem('dogebot.douyinShowOnClickFailure') === '1',
    shortIntervalSeconds: readPositiveNumber('dogebot.douyinShortIntervalSeconds', 10),
    longIntervalSeconds: readPositiveNumber('dogebot.douyinLongIntervalSeconds', 60),
    retryLimit: readPositiveNumber('dogebot.douyinRetryLimit', 3)
  };
}

export function createDefaultTask(partial: Partial<DouyinTask> = {}): DouyinTask {
  const defaults = readGlobalTaskDefaults();
  return {
    id: partial.id || createTaskId(),
    enabled: partial.enabled ?? true,
    partitionId: partial.partitionId || DEFAULT_PARTITION_ID,
    favoriteUrl: partial.favoriteUrl || defaultFavoriteUrl,
    collectListUrl: partial.collectListUrl || defaultCollectListUrl,
    requestUrlFilter: partial.requestUrlFilter || defaultRequestUrlFilter,
    clickText: partial.clickText || '',
    skipClick: partial.skipClick ?? false,
    runHidden: partial.runHidden ?? defaults.runHidden,
    showOnClickFailure: partial.showOnClickFailure ?? defaults.showOnClickFailure,
    shortIntervalSeconds: partial.shortIntervalSeconds ?? defaults.shortIntervalSeconds,
    longIntervalSeconds: partial.longIntervalSeconds ?? defaults.longIntervalSeconds,
    retryLimit: partial.retryLimit ?? defaults.retryLimit,
    destroyOnStop: partial.destroyOnStop ?? true
  };
}

export function normalizeStoredTask(value: unknown): DouyinTask | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return createDefaultTask({
    id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : createTaskId(),
    enabled: record.enabled !== false,
    partitionId: typeof record.partitionId === 'string' && record.partitionId.trim() ? record.partitionId.trim() : DEFAULT_PARTITION_ID,
    favoriteUrl: typeof record.favoriteUrl === 'string' && record.favoriteUrl.trim() ? record.favoriteUrl.trim() : defaultFavoriteUrl,
    collectListUrl: typeof record.collectListUrl === 'string' && record.collectListUrl.trim() ? record.collectListUrl.trim() : defaultCollectListUrl,
    requestUrlFilter: typeof record.requestUrlFilter === 'string' && record.requestUrlFilter.trim()
      ? record.requestUrlFilter.trim()
      : typeof record.collectsId === 'string' && record.collectsId.trim()
        ? record.collectsId.trim()
        : defaultRequestUrlFilter,
    clickText: typeof record.clickText === 'string' ? record.clickText.trim() : '',
    skipClick: Boolean(record.skipClick),
    runHidden: typeof record.runHidden === 'boolean' ? record.runHidden : undefined,
    showOnClickFailure: typeof record.showOnClickFailure === 'boolean' ? record.showOnClickFailure : undefined,
    shortIntervalSeconds: optionalPositiveInteger(record.shortIntervalSeconds),
    longIntervalSeconds: optionalPositiveInteger(record.longIntervalSeconds),
    retryLimit: optionalPositiveInteger(record.retryLimit),
    destroyOnStop: typeof record.destroyOnStop === 'boolean' ? record.destroyOnStop : undefined
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

export function readStoredPartitions(): DouyinPartition[] {
  const fallback: DouyinPartition[] = [{ id: DEFAULT_PARTITION_ID, name: '默认' }];
  const stored = localStorage.getItem('dogebot.douyinPartitions');
  if (!stored) return fallback;
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return fallback;
    const list = parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : '';
      const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id;
      return id ? [{ id, name }] : [];
    });
    if (!list.some((partition) => partition.id === DEFAULT_PARTITION_ID)) {
      list.unshift({ id: DEFAULT_PARTITION_ID, name: '默认' });
    }
    return list.length > 0 ? list : fallback;
  } catch {
    return fallback;
  }
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
