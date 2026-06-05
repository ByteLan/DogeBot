type Bot = {
  id: number;
  name: string;
  appId: string;
  domain: string;
  botName: string | null;
  botOpenId: string | null;
  webhookPath: string;
};

type QrBegin = {
  deviceCode: string;
  qrUrl: string;
  interval: number;
  expireIn: number;
  domain: string;
};

type Connection = {
  botId: number;
  status: string;
  error?: string;
};

let token = localStorage.getItem('dogebot.token') || '';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const serverUrl = $('serverUrl') as HTMLInputElement;
const message = $('message');
const loginSection = $('loginSection');
const appSection = $('appSection');
let qrPollTimer: ReturnType<typeof setTimeout> | undefined;

serverUrl.value = localStorage.getItem('dogebot.serverUrl') || serverUrl.value;

function setMessage(text: string) {
  message.textContent = text;
}

function stopQrPolling() {
  if (qrPollTimer) clearTimeout(qrPollTimer);
  qrPollTimer = undefined;
}

async function pollQrRegistration(registration: QrBegin, startedAt: number) {
  if (Date.now() - startedAt > registration.expireIn * 1000) {
    setMessage('扫码已超时，请重新发起');
    stopQrPolling();
    return;
  }

  try {
    const result = await api<{ status: 'pending' | 'success' | 'denied' | 'expired'; domain: string; interval?: number }>('/api/feishu/qr-registration/poll', {
      method: 'POST',
      body: JSON.stringify({
        deviceCode: registration.deviceCode,
        domain: registration.domain,
        interval: registration.interval
      })
    });
    if (result.status === 'success') {
      setMessage('扫码绑定成功');
      $('qrRegisterBox').classList.add('hidden');
      stopQrPolling();
      await loadBots();
      return;
    }
    if (result.status === 'denied' || result.status === 'expired') {
      setMessage(result.status === 'denied' ? '扫码授权已拒绝' : '扫码已过期');
      stopQrPolling();
      return;
    }
    qrPollTimer = setTimeout(() => void pollQrRegistration({ ...registration, domain: result.domain, interval: result.interval || registration.interval }, startedAt), (result.interval || registration.interval) * 1000);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '扫码状态查询失败');
    qrPollTimer = setTimeout(() => void pollQrRegistration(registration, startedAt), registration.interval * 1000);
  }
}

function apiUrl(path: string) {
  return `${serverUrl.value.replace(/\/$/, '')}${path}`;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function showApp(loggedIn: boolean) {
  loginSection.classList.toggle('hidden', loggedIn);
  appSection.classList.toggle('hidden', !loggedIn);
}

async function loadBots() {
  const [data, connectionData] = await Promise.all([
    api<{ bots: Bot[] }>('/api/feishu/bots'),
    api<{ connections: Connection[] }>('/api/feishu/connections')
  ]);
  const connections = new Map(connectionData.connections.map((connection) => [connection.botId, connection]));
  const list = $('botList');
  if (data.bots.length === 0) {
    list.textContent = '暂无';
    return;
  }

  list.innerHTML = '';
  for (const bot of data.bots) {
    const item = document.createElement('div');
    item.className = 'bot';
    const webhookUrl = apiUrl(bot.webhookPath);
    const connection = connections.get(bot.id);
    const status = connection ? connection.status : '未连接';
    const error = connection?.error ? ` · ${connection.error}` : '';
    item.innerHTML = `<div><strong>${bot.name}</strong><div class="muted">${bot.botName || '未探测'} · ${bot.domain}</div><div>长连接: ${status}${error}</div><div>Webhook: <code>${webhookUrl}</code></div></div>`;

    const actions = document.createElement('div');
    const probe = document.createElement('button');
    probe.className = 'secondary';
    probe.textContent = '探测';
    probe.onclick = async () => {
      await api(`/api/feishu/bots/${bot.id}/probe`, { method: 'POST' });
      setMessage('探测成功');
      await loadBots();
    };

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.onclick = async () => {
      await api(`/api/feishu/bots/${bot.id}`, { method: 'DELETE' });
      setMessage('已删除');
      await loadBots();
    };

    actions.append(probe, del);
    item.append(actions);
    list.append(item);
  }
}

$('loginBtn').onclick = async () => {
  try {
    const username = ($('username') as HTMLInputElement).value;
    const password = ($('password') as HTMLInputElement).value;
    const data = await api<{ token: string }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    token = data.token;
    localStorage.setItem('dogebot.token', token);
    localStorage.setItem('dogebot.serverUrl', serverUrl.value);
    showApp(true);
    setMessage('登录成功');
    await loadBots();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '登录失败');
  }
};

$('logoutBtn').onclick = () => {
  token = '';
  localStorage.removeItem('dogebot.token');
  showApp(false);
  setMessage('已退出');
};

$('createBotBtn').onclick = async () => {
  try {
    await api('/api/feishu/bots', {
      method: 'POST',
      body: JSON.stringify({
        name: ($('botName') as HTMLInputElement).value,
        appId: ($('appId') as HTMLInputElement).value,
        appSecret: ($('appSecret') as HTMLInputElement).value,
        domain: ($('botDomain') as HTMLSelectElement).value,
        verificationToken: ($('verificationToken') as HTMLInputElement).value,
        encryptKey: ($('encryptKey') as HTMLInputElement).value
      })
    });
    setMessage('绑定成功');
    await loadBots();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '绑定失败');
  }
};

$('qrRegisterBtn').onclick = async () => {
  try {
    stopQrPolling();
    const registration = await api<QrBegin>('/api/feishu/qr-registration/begin', {
      method: 'POST',
      body: JSON.stringify({ domain: ($('botDomain') as HTMLSelectElement).value })
    });
    const link = $('qrRegisterLink') as HTMLAnchorElement;
    link.href = registration.qrUrl;
    link.textContent = registration.qrUrl;
    $('qrRegisterBox').classList.remove('hidden');
    setMessage('请打开扫码链接并完成飞书授权');
    qrPollTimer = setTimeout(() => void pollQrRegistration(registration, Date.now()), registration.interval * 1000);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '发起扫码失败');
  }
};

showApp(Boolean(token));
if (token) loadBots().catch(() => showApp(false));
