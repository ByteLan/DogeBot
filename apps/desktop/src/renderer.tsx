import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, Button, Card, Form, Grid, Input, Link, List, Select, Space, Switch, Tabs, Typography } from '@arco-design/web-react';
import '@arco-design/web-react/dist/css/arco.css';
import { JsonView, allExpanded, collapseAllNested, darkStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import './style.css';

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

type DouyinBridge = {
  openLogin: () => Promise<void>;
  startMonitor: (clickText: string, hidden?: boolean, showOnClickFailure?: boolean, collectsId?: string, skipClick?: boolean) => Promise<void>;
  stopMonitor: () => Promise<void>;
  setHidden: (hidden: boolean) => Promise<void>;
  onClickResult: (listener: (data: unknown) => void) => () => void;
  onCollectsVideoList: (listener: (data: unknown) => void) => () => void;
};

type DouyinEvent = {
  id: string;
  title: string;
  data: unknown;
};

declare global {
  interface Window {
    douyin?: DouyinBridge;
  }
}

const { Title, Text, Paragraph } = Typography;
const { Row, Col } = Grid;
const initialServerUrl = localStorage.getItem('dogebot.serverUrl') || 'http://127.0.0.1:3000';
const douyinCollectListUrl = 'https://www.douyin.com/aweme/v1/web/collects/video/list/';

function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isDouyinCollectListUrl(url: unknown) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}` === douyinCollectListUrl;
  } catch {
    return false;
  }
}

function parseCollectListBody(data: unknown): unknown | undefined {
  if (!data || typeof data !== 'object' || !('body' in data)) return data;
  const record = data as Record<string, unknown>;
  if (!isDouyinCollectListUrl(record.url)) return undefined;
  return typeof record.body === 'string' ? parseJson(record.body) : record.body;
}

function extractAwemeIds(body: unknown) {
  if (!body || typeof body !== 'object') return [];
  const awemeList = (body as { aweme_list?: unknown }).aweme_list;
  if (!Array.isArray(awemeList)) return [];
  return awemeList.flatMap((item) => {
    const awemeId = item && typeof item === 'object' ? String((item as { aweme_id?: unknown }).aweme_id || '').trim() : '';
    return awemeId ? [awemeId] : [];
  });
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('dogebot.token') || '');
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [message, setMessage] = useState('');
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [botForm, setBotForm] = useState({
    name: '',
    domain: 'feishu',
    appId: '',
    appSecret: '',
    verificationToken: '',
    encryptKey: ''
  });
  const [bots, setBots] = useState<Bot[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [qrRegistration, setQrRegistration] = useState<QrBegin | undefined>();
  const [douyinClickText, setDouyinClickText] = useState(() => localStorage.getItem('dogebot.douyinClickText') || '');
  const [douyinCollectsId, setDouyinCollectsId] = useState(() => localStorage.getItem('dogebot.douyinCollectsId') || '');
  const [douyinRunHidden, setDouyinRunHidden] = useState(() => localStorage.getItem('dogebot.douyinRunHidden') === '1');
  const [douyinShowOnClickFailure, setDouyinShowOnClickFailure] = useState(() => localStorage.getItem('dogebot.douyinShowOnClickFailure') === '1');
  const [douyinSkipClick, setDouyinSkipClick] = useState(() => localStorage.getItem('dogebot.douyinSkipClick') === '1');
  const [douyinStatus, setDouyinStatus] = useState(window.douyin ? '未开始' : 'Douyin preload 未加载，请检查终端日志');
  const [douyinEvents, setDouyinEvents] = useState<DouyinEvent[]>([]);

  const loggedIn = Boolean(token);
  const connectionMap = useMemo(() => new Map(connections.map((connection) => [connection.botId, connection])), [connections]);

  const apiUrl = useCallback((path: string) => `${serverUrl.replace(/\/$/, '')}${path}`, [serverUrl]);

  const api = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
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
    },
    [apiUrl, token]
  );

  const loadBots = useCallback(async () => {
    const [botData, connectionData] = await Promise.all([
      api<{ bots: Bot[] }>('/api/feishu/bots'),
      api<{ connections: Connection[] }>('/api/feishu/connections')
    ]);
    setBots(botData.bots);
    setConnections(connectionData.connections);
  }, [api]);

  useEffect(() => {
    if (!token) return;
    loadBots().catch((error) => {
      console.error('[desktop renderer] load bots failed', error);
      setToken('');
      localStorage.removeItem('dogebot.token');
    });
  }, [loadBots, token]);

  useEffect(() => {
    if (!window.douyin) return;
    console.log('[douyin renderer] bridge ready');
    const addCollectListBody = (data: unknown) => {
      const body = parseCollectListBody(data);
      if (body === undefined) return;
      const awemeIds = extractAwemeIds(body);
      setDouyinEvents((items) => [{ id: `${Date.now()}-collects-video-list`, title: douyinCollectListUrl, data: body }, ...items].slice(0, 10));
      if (awemeIds.length === 0) return;
      const clickText = douyinClickText.trim();
      if (!clickText) return;
      api<{ inserted: number; total: number }>('/api/douyin/aweme-records', {
        method: 'POST',
        body: JSON.stringify({ clickText, awemeIds })
      })
        .then((result) => setDouyinStatus(`已同步 ${awemeIds.length} 个 aweme_id，新增 ${result.inserted} 个，当前累计 ${result.total} 个`))
        .catch((error) => {
          console.error('[douyin renderer] upload aweme ids failed', error);
          setDouyinStatus(error instanceof Error ? `同步 aweme_id 失败：${error.message}` : '同步 aweme_id 失败');
        });
    };
    const offClick = window.douyin.onClickResult((data) => {
      const result = data as { clicked?: boolean; reason?: string; text?: string; skipped?: boolean };
      setDouyinStatus(result.skipped ? '已刷新页面并跳过点击，继续监听 API' : result.clicked ? `已点击：${result.text || douyinClickText}` : `点击失败：${result.reason || '未知原因'}`);
    });
    const offList = window.douyin.onCollectsVideoList(addCollectListBody);
    return () => {
      offClick();
      offList();
    };
  }, [api, douyinClickText]);

  const requireDouyinBridge = () => {
    if (window.douyin) return window.douyin;
    const error = 'Douyin preload 未加载，请看终端是否有 preload 路径或脚本报错';
    console.error(`[douyin renderer] ${error}`);
    setDouyinStatus(error);
    throw new Error(error);
  };

  const login = async () => {
    try {
      const data = await api<{ token: string }>('/api/login', {
        method: 'POST',
        body: JSON.stringify(loginForm)
      });
      setToken(data.token);
      localStorage.setItem('dogebot.token', data.token);
      localStorage.setItem('dogebot.serverUrl', serverUrl);
      setMessage('登录成功');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '登录失败');
    }
  };

  const logout = () => {
    setToken('');
    localStorage.removeItem('dogebot.token');
    setMessage('已退出');
  };

  const createBot = async () => {
    try {
      await api('/api/feishu/bots', {
        method: 'POST',
        body: JSON.stringify(botForm)
      });
      setMessage('绑定成功');
      await loadBots();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '绑定失败');
    }
  };

  const probeBot = async (bot: Bot) => {
    await api(`/api/feishu/bots/${bot.id}/probe`, { method: 'POST' });
    setMessage('探测成功');
    await loadBots();
  };

  const deleteBot = async (bot: Bot) => {
    await api(`/api/feishu/bots/${bot.id}`, { method: 'DELETE' });
    setMessage('已删除');
    await loadBots();
  };

  const beginQrRegistration = async () => {
    try {
      const registration = await api<QrBegin>('/api/feishu/qr-registration/begin', {
        method: 'POST',
        body: JSON.stringify({ domain: botForm.domain })
      });
      setQrRegistration(registration);
      setMessage('请打开扫码链接并完成飞书授权');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '发起扫码失败');
    }
  };

  useEffect(() => {
    if (!qrRegistration) return;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = async (registration: QrBegin) => {
      if (stopped) return;
      if (Date.now() - startedAt > registration.expireIn * 1000) {
        setMessage('扫码已超时，请重新发起');
        setQrRegistration(undefined);
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
          setQrRegistration(undefined);
          await loadBots();
          return;
        }
        if (result.status === 'denied' || result.status === 'expired') {
          setMessage(result.status === 'denied' ? '扫码授权已拒绝' : '扫码已过期');
          setQrRegistration(undefined);
          return;
        }
        const next = { ...registration, domain: result.domain, interval: result.interval || registration.interval };
        timer = setTimeout(() => void poll(next), next.interval * 1000);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '扫码状态查询失败');
        timer = setTimeout(() => void poll(registration), registration.interval * 1000);
      }
    };
    timer = setTimeout(() => void poll(qrRegistration), qrRegistration.interval * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, loadBots, qrRegistration]);

  const openDouyinLogin = async () => {
    try {
      console.log('[douyin renderer] click login');
      setDouyinStatus('正在打开 douyin.com...');
      await requireDouyinBridge().openLogin();
      setDouyinStatus('已打开 douyin.com，请在弹出的浏览器窗口完成登录');
    } catch (error) {
      setDouyinStatus(error instanceof Error ? error.message : '打开抖音登录失败');
    }
  };

  const startDouyinMonitor = async () => {
    try {
      const text = douyinClickText.trim();
      if (!text) {
        setDouyinStatus('请先填写模拟点击字样');
        return;
      }
      const collectsId = douyinCollectsId.trim();
      if (!collectsId) {
        setDouyinStatus('请先填写 collects_id');
        return;
      }
      localStorage.setItem('dogebot.douyinClickText', text);
      localStorage.setItem('dogebot.douyinCollectsId', collectsId);
      localStorage.setItem('dogebot.douyinRunHidden', douyinRunHidden ? '1' : '0');
      localStorage.setItem('dogebot.douyinShowOnClickFailure', douyinShowOnClickFailure ? '1' : '0');
      localStorage.setItem('dogebot.douyinSkipClick', douyinSkipClick ? '1' : '0');
      console.log('[douyin renderer] start monitor', { text, hidden: douyinRunHidden, showOnClickFailure: douyinShowOnClickFailure, collectsId, skipClick: douyinSkipClick });
      setDouyinStatus(douyinSkipClick ? '监听中：每 10 秒刷新收藏页，不执行点击，只监听 API' : douyinRunHidden ? '后台监听中：每 10 秒跳转收藏页并模拟点击' : '前台监听中：每 10 秒跳转收藏页并模拟点击');
      await requireDouyinBridge().startMonitor(text, douyinRunHidden, douyinShowOnClickFailure, collectsId, douyinSkipClick);
    } catch (error) {
      setDouyinStatus(error instanceof Error ? error.message : '开始监听失败');
    }
  };

  const stopDouyinMonitor = async () => {
    console.log('[douyin renderer] stop monitor');
    await requireDouyinBridge().stopMonitor();
    setDouyinStatus('已停止监听');
  };

  return (
    <main className="app-shell">
      <Title heading={2}>DogeBot</Title>
      {message ? <Alert className="app-message" type="info" content={message} /> : null}

      {!loggedIn ? (
        <Card title="登录服务端">
          <Form layout="vertical">
            <Form.Item label="服务端 URL">
              <Input value={serverUrl} onChange={setServerUrl} />
            </Form.Item>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item label="用户名">
                  <Input value={loginForm.username} autoComplete="username" onChange={(username) => setLoginForm((form) => ({ ...form, username }))} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="密码">
                  <Input.Password value={loginForm.password} autoComplete="current-password" onChange={(password) => setLoginForm((form) => ({ ...form, password }))} />
                </Form.Item>
              </Col>
            </Row>
            <Button type="primary" onClick={login}>登录</Button>
          </Form>
        </Card>
      ) : (
        <>
          <Card title="飞书机器人绑定">
            <Paragraph type="secondary">绑定后，在飞书开放平台配置事件回调地址为对应 webhook URL。当前机器人会把用户发来的文本原样回复。</Paragraph>
            <Form layout="vertical">
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="名称">
                    <Input value={botForm.name} placeholder="Doge Echo Bot" onChange={(name) => setBotForm((form) => ({ ...form, name }))} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="域名">
                    <Select value={botForm.domain} onChange={(domain) => setBotForm((form) => ({ ...form, domain }))}>
                      <Select.Option value="feishu">feishu</Select.Option>
                      <Select.Option value="lark">lark</Select.Option>
                    </Select>
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label="App ID">
                <Input value={botForm.appId} onChange={(appId) => setBotForm((form) => ({ ...form, appId }))} />
              </Form.Item>
              <Form.Item label="App Secret">
                <Input.Password value={botForm.appSecret} onChange={(appSecret) => setBotForm((form) => ({ ...form, appSecret }))} />
              </Form.Item>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="Verification Token">
                    <Input value={botForm.verificationToken} onChange={(verificationToken) => setBotForm((form) => ({ ...form, verificationToken }))} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="Encrypt Key">
                    <Input value={botForm.encryptKey} onChange={(encryptKey) => setBotForm((form) => ({ ...form, encryptKey }))} />
                  </Form.Item>
                </Col>
              </Row>
              <Space>
                <Button type="primary" onClick={createBot}>绑定机器人</Button>
                <Button onClick={beginQrRegistration}>扫码创建并绑定</Button>
                <Button onClick={logout}>退出登录</Button>
              </Space>
            </Form>
            {qrRegistration ? (
              <Alert
                className="qr-box"
                type="info"
                content={<span>请在飞书中打开下面链接并扫码授权：<Link href={qrRegistration.qrUrl} target="_blank">{qrRegistration.qrUrl}</Link></span>}
              />
            ) : null}
            <Title heading={5}>已绑定</Title>
            <List
              dataSource={bots}
              noDataElement={<Text type="secondary">暂无</Text>}
              render={(bot) => {
                const connection = connectionMap.get(bot.id);
                const status = connection ? connection.status : '未连接';
                const error = connection?.error ? ` · ${connection.error}` : '';
                return (
                  <List.Item
                    actions={[
                      <Button key="probe" size="small" onClick={() => void probeBot(bot)}>探测</Button>,
                      <Button key="delete" size="small" status="danger" onClick={() => void deleteBot(bot)}>删除</Button>
                    ]}
                  >
                    <List.Item.Meta
                      title={bot.name}
                      description={
                        <Space direction="vertical" size={2}>
                          <Text type="secondary">{bot.botName || '未探测'} · {bot.domain}</Text>
                          <Text>长连接: {status}{error}</Text>
                          <Text>Webhook: <code>{apiUrl(bot.webhookPath)}</code></Text>
                        </Space>
                      }
                    />
                  </List.Item>
                );
              }}
            />
          </Card>

          <Card title="抖音收藏监听">
            <Paragraph type="secondary">登录态保存在本机 Electron 持久会话中。开始监听后，每 10 秒打开收藏页并点击页面上包含指定字样的组件，然后捕获 <code>collects/video/list</code> 接口返回值。</Paragraph>
            <Form layout="vertical">
              <Form.Item label="模拟点击字样">
                <Input value={douyinClickText} placeholder="例如：默认收藏夹" onChange={setDouyinClickText} />
              </Form.Item>
              <Form.Item label="collects_id">
                <Input
                  value={douyinCollectsId}
                  placeholder="只收集 URL 参数匹配该 collects_id 的返回"
                  onChange={(value) => {
                    setDouyinCollectsId(value);
                    localStorage.setItem('dogebot.douyinCollectsId', value.trim());
                  }}
                />
              </Form.Item>
              <Form.Item label="执行方式">
                <Space direction="vertical" align="start">
                  <Space>
                    <Switch
                      checked={douyinRunHidden}
                      onChange={(checked) => {
                        setDouyinRunHidden(checked);
                        localStorage.setItem('dogebot.douyinRunHidden', checked ? '1' : '0');
                        window.douyin?.setHidden(checked).catch((error) => {
                          console.error('[douyin renderer] set hidden failed', error);
                          setDouyinStatus(error instanceof Error ? error.message : '切换 Douyin 窗口显示状态失败');
                        });
                      }}
                    />
                    <Text type="secondary">{douyinRunHidden ? '隐藏 Douyin 窗口后台执行' : '显示 Douyin 窗口前台执行'}</Text>
                  </Space>
                  <Space>
                    <Switch
                      checked={douyinShowOnClickFailure}
                      onChange={(checked) => {
                        setDouyinShowOnClickFailure(checked);
                        localStorage.setItem('dogebot.douyinShowOnClickFailure', checked ? '1' : '0');
                      }}
                    />
                    <Text type="secondary">点击失败立即弹到前台</Text>
                  </Space>
                  <Space>
                    <Switch
                      checked={douyinSkipClick}
                      onChange={(checked) => {
                        setDouyinSkipClick(checked);
                        localStorage.setItem('dogebot.douyinSkipClick', checked ? '1' : '0');
                      }}
                    />
                    <Text type="secondary">不点击，仅刷新页面并监听 API</Text>
                  </Space>
                </Space>
              </Form.Item>
              <Space>
                <Button type="primary" onClick={openDouyinLogin}>登录 douyin.com</Button>
                <Button onClick={startDouyinMonitor}>开始监听</Button>
                <Button onClick={stopDouyinMonitor}>停止监听</Button>
              </Space>
            </Form>
            <Alert className="douyin-status" type="info" content={douyinStatus} />
            <Title heading={5}>接口返回</Title>
            {douyinEvents.length === 0 ? (
              <div className="json-empty">暂无</div>
            ) : (
              <Space direction="vertical" className="json-list">
                {douyinEvents.map((event) => (
                  <Card key={event.id} className="json-card" title={`${new Date(Number(event.id.split('-')[0])).toLocaleString()} · ${event.title}`}>
                    <Tabs defaultActiveTab="awemeIds">
                      <Tabs.TabPane key="awemeIds" title="aweme_id">
                        <JsonView data={extractAwemeIds(event.data)} shouldExpandNode={allExpanded} style={darkStyles} />
                      </Tabs.TabPane>
                      <Tabs.TabPane key="body" title="Body">
                        <JsonView data={event.data} shouldExpandNode={collapseAllNested} style={darkStyles} />
                      </Tabs.TabPane>
                    </Tabs>
                  </Card>
                ))}
              </Space>
            )}
          </Card>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
