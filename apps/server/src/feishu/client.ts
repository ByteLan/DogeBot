import type { FeishuBot, TokenCacheEntry } from '../types.js';

const FEISHU_BASE: Record<string, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com'
};

const tokenCache = new Map<number, TokenCacheEntry>();

export function openBase(domain: string) {
  return FEISHU_BASE[domain] || FEISHU_BASE.feishu;
}

/** Error carrying the Feishu business `code` so callers can classify failures. */
export class FeishuApiError extends Error {
  readonly code: number;
  readonly httpStatus: number;
  constructor(message: string, code: number, httpStatus: number) {
    super(message);
    this.name = 'FeishuApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// Feishu business codes that mean "this chat/user will never accept our message"
// (bot stopped / removed / not in chat). Retrying or logging them as errors on
// passive pushes is noise, so callers treat these as skippable.
const BOT_BLOCKED_CODES = new Set([230002, 230013, 230017, 230034, 230035]);

export function isBotBlockedError(error: unknown): boolean {
  if (error instanceof FeishuApiError && BOT_BLOCKED_CODES.has(error.code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /stopped the bot|not in the chat|bot is not|hasn't opened|has not opened/i.test(message);
}

export async function feishuJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => ({}))) as T & { code?: number; msg?: string };
  if (!response.ok || (typeof data.code === 'number' && data.code !== 0)) {
    throw new FeishuApiError(
      data.msg || `Feishu request failed: ${response.status}`,
      typeof data.code === 'number' ? data.code : -1,
      response.status
    );
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
