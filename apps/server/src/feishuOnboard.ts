import { createFeishuBotFromCredentials, getBot, probeBot, publicBot } from './feishu.js';
import { feishuConnectionManager } from './feishuConnection.js';

const ACCOUNTS_BASE: Record<string, string> = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com'
};

const REGISTRATION_PATH = '/oauth/v1/app/registration';

type RegistrationResult =
  | { status: 'pending'; domain: string; interval: number }
  | { status: 'denied' | 'expired'; domain: string }
  | { status: 'success'; domain: string; bot: ReturnType<typeof publicBot> };

function accountsBase(domain: string) {
  return ACCOUNTS_BASE[domain] || ACCOUNTS_BASE.feishu;
}

async function postRegistration(domain: string, body: Record<string, string>) {
  const response = await fetch(`${accountsBase(domain)}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !data.error) throw new Error(`registration request failed: ${response.status}`);
  return data as Record<string, any>;
}

export async function beginFeishuQrRegistration(domain = 'feishu') {
  const init = await postRegistration(domain, { action: 'init' });
  const methods = init.supported_auth_methods || [];
  if (!methods.includes('client_secret')) {
    throw new Error(`registration does not support client_secret auth: ${methods.join(', ')}`);
  }

  const begin = await postRegistration(domain, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id'
  });
  const deviceCode = begin.device_code;
  if (!deviceCode) throw new Error('registration did not return device_code');

  const qrUrl = String(begin.verification_uri_complete || '');
  return {
    deviceCode,
    qrUrl: qrUrl.includes('?') ? `${qrUrl}&from=dogebot&tp=dogebot` : `${qrUrl}?from=dogebot&tp=dogebot`,
    userCode: begin.user_code || '',
    interval: begin.interval || 5,
    expireIn: begin.expire_in || 600,
    domain
  };
}

export async function pollFeishuQrRegistration(params: { userId: number; deviceCode: string; domain?: string; interval?: number }): Promise<RegistrationResult> {
  const initialDomain = params.domain || 'feishu';
  const result = await postRegistration(initialDomain, {
    action: 'poll',
    device_code: params.deviceCode,
    tp: 'ob_app'
  });

  const userInfo = result.user_info || {};
  const domain = userInfo.tenant_brand === 'lark' ? 'lark' : initialDomain;
  if (result.client_id && result.client_secret) {
    const created = createFeishuBotFromCredentials(params.userId, {
      name: 'Feishu Bot',
      appId: result.client_id,
      appSecret: result.client_secret,
      domain
    });
    if (!created.bot) throw new Error(created.error || 'failed to create bot');

    await probeBot(created.bot).catch(() => undefined);
    const bot = getBot(created.bot.id) || created.bot;
    void feishuConnectionManager.startBot(bot);
    return { status: 'success', domain, bot: publicBot(bot) };
  }

  if (result.error === 'access_denied') return { status: 'denied', domain };
  if (result.error === 'expired_token') return { status: 'expired', domain };
  return { status: 'pending', domain, interval: params.interval || 5 };
}
