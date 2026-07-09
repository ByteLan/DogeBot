import type { FeishuBot, TokenCacheEntry } from '../types.js';

const FEISHU_BASE: Record<string, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com'
};

const tokenCache = new Map<number, TokenCacheEntry>();

export function openBase(domain: string) {
  return FEISHU_BASE[domain] || FEISHU_BASE.feishu;
}

export async function feishuJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => ({}))) as T & { code?: number; msg?: string };
  if (!response.ok || (typeof data.code === 'number' && data.code !== 0)) {
    throw new Error(data.msg || `Feishu request failed: ${response.status}`);
  }
  return data;
}

export async function tenantAccessToken(bot: FeishuBot) {
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

export function clearTokenCache(botId: number) {
  tokenCache.delete(botId);
}

export async function feishuSdkClient(bot: FeishuBot) {
  const lark = await import('@larksuiteoapi/node-sdk');
  return new lark.Client({
    appId: bot.app_id,
    appSecret: bot.app_secret,
    domain: bot.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.warn,
    source: 'dogebot'
  });
}
