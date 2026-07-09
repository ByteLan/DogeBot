const FEISHU_EVENT_DEDUP_TTL_MS = 10 * 60 * 1000;
const recentFeishuEventKeys = new Map<string, number>();

function cleanupRecentFeishuEventKeys(now: number) {
  for (const [eventKey, expiresAt] of recentFeishuEventKeys) {
    if (expiresAt <= now) recentFeishuEventKeys.delete(eventKey);
  }
}

export function rememberFeishuEventKey(eventKey: string) {
  const now = Date.now();
  cleanupRecentFeishuEventKeys(now);
  if (recentFeishuEventKeys.has(eventKey)) return false;
  recentFeishuEventKeys.set(eventKey, now + FEISHU_EVENT_DEDUP_TTL_MS);
  return true;
}
