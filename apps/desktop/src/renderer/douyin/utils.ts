import type { DouyinEvent } from '../types';

export function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function buildUrlHistory(defaultValue: string, values: Array<string | undefined>) {
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    const next = typeof value === 'string' ? value.trim() : '';
    if (!next || seen.has(next)) return;
    seen.add(next);
    result.push(next);
  };
  push(defaultValue);
  for (const value of values) push(value);
  return result;
}

export function mergeHistoryValues(defaultValue: string, current: string[], values: Array<string | undefined>) {
  return buildUrlHistory(defaultValue, [...current, ...values]).filter((value) => value !== defaultValue);
}

export function parseCollectListBody(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('body' in data)) return data;
  const record = data as Record<string, unknown>;
  return typeof record.body === 'string' ? parseJson(record.body) : record.body;
}

export function appendEventRecord(records: Record<string, DouyinEvent[]>, taskId: string, event: DouyinEvent) {
  return {
    ...records,
    [taskId]: [event, ...(records[taskId] || [])].slice(0, 10)
  };
}
