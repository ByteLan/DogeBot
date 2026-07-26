import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Typography } from '@arco-design/web-react';
import { defaultFavoriteUrl, defaultCollectListUrl, defaultRequestUrlFilter } from '../shared/constants';
import { isValidHttpUrl } from '../shared/url';
import { useApi } from './api';
import { useDouyinBridge } from './douyin/hooks';
import { buildUrlHistory, mergeHistoryValues } from './douyin/utils';
import { useQrRegistration } from './feishu/hooks';
import {
  createDefaultTask,
  initialServerUrl,
  readPositiveNumber,
  readStoredStringList,
  readStoredTasks,
  usePersistentState
} from './storage';
import type {
  Bot,
  BotForm,
  Connection,
  DouyinEvent,
  DouyinMonitorState,
  DouyinMonitorTaskPayload,
  DouyinTask,
  LoginForm,
  QrBegin
} from './types';
import { LoginCard } from './components/LoginCard';
import { FeishuBotsCard } from './components/FeishuBotsCard';
import { DouyinMonitorCard } from './components/DouyinMonitorCard';

const { Title } = Typography;

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem('dogebot.token') || '');
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [message, setMessage] = useState('');
  const [loginForm, setLoginForm] = useState<LoginForm>({ username: '', password: '' });
  const [botForm, setBotForm] = useState<BotForm>({
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
  const [douyinTasks, setDouyinTasks] = usePersistentState<DouyinTask[]>(
    readStoredTasks,
    (value) => localStorage.setItem('dogebot.douyinTasks', JSON.stringify(value))
  );
  const [favoriteUrlHistory, setFavoriteUrlHistory] = usePersistentState<string[]>(
    () => readStoredStringList('dogebot.douyinFavoriteUrlHistory'),
    (value) => localStorage.setItem('dogebot.douyinFavoriteUrlHistory', JSON.stringify(value))
  );
  const [collectListUrlHistory, setCollectListUrlHistory] = usePersistentState<string[]>(
    () => readStoredStringList('dogebot.douyinCollectListUrlHistory'),
    (value) => localStorage.setItem('dogebot.douyinCollectListUrlHistory', JSON.stringify(value))
  );
  const [requestUrlFilterHistory, setRequestUrlFilterHistory] = usePersistentState<string[]>(
    () => readStoredStringList('dogebot.douyinRequestUrlFilterHistory'),
    (value) => localStorage.setItem('dogebot.douyinRequestUrlFilterHistory', JSON.stringify(value))
  );
  const [douyinRunHidden, setDouyinRunHidden] = usePersistentState<boolean>(
    () => localStorage.getItem('dogebot.douyinRunHidden') === '1',
    (value) => localStorage.setItem('dogebot.douyinRunHidden', value ? '1' : '0')
  );
  const [douyinShowOnClickFailure, setDouyinShowOnClickFailure] = usePersistentState<boolean>(
    () => localStorage.getItem('dogebot.douyinShowOnClickFailure') === '1',
    (value) => localStorage.setItem('dogebot.douyinShowOnClickFailure', value ? '1' : '0')
  );
  const [douyinShortIntervalSeconds, setDouyinShortIntervalSeconds] = usePersistentState<number>(
    () => readPositiveNumber('dogebot.douyinShortIntervalSeconds', 10),
    (value) => localStorage.setItem('dogebot.douyinShortIntervalSeconds', String(value))
  );
  const [douyinLongIntervalSeconds, setDouyinLongIntervalSeconds] = usePersistentState<number>(
    () => readPositiveNumber('dogebot.douyinLongIntervalSeconds', 60),
    (value) => localStorage.setItem('dogebot.douyinLongIntervalSeconds', String(value))
  );
  const [douyinRetryLimit, setDouyinRetryLimit] = usePersistentState<number>(
    () => readPositiveNumber('dogebot.douyinRetryLimit', 3),
    (value) => localStorage.setItem('dogebot.douyinRetryLimit', String(value))
  );
  const [douyinStatus, setDouyinStatus] = useState(window.douyin ? '未开始' : 'Douyin preload 未加载，请检查终端日志');
  const [douyinMonitorState, setDouyinMonitorState] = useState<DouyinMonitorState>({
    running: false,
    mode: 'short',
    currentIntervalSeconds: douyinShortIntervalSeconds,
    shortIntervalSeconds: douyinShortIntervalSeconds,
    longIntervalSeconds: douyinLongIntervalSeconds,
    sameIdsCount: 0,
    retryLimit: douyinRetryLimit,
    nextRunAt: '',
    tickRunning: false,
    taskCount: 0,
    activeTaskId: '',
    activeTaskLabel: ''
  });
  const [douyinTaskStatusMap, setDouyinTaskStatusMap] = useState<Record<string, string>>({});
  const [douyinTaskEvents, setDouyinTaskEvents] = useState<Record<string, DouyinEvent[]>>({});

  const loggedIn = Boolean(token);
  const connectionMap = useMemo(() => new Map(connections.map((connection) => [connection.botId, connection])), [connections]);
  const activeDouyinTasks = useMemo(() => douyinTasks.filter((task) => task.enabled), [douyinTasks]);
  const favoriteUrlOptions = useMemo(
    () => buildUrlHistory(defaultFavoriteUrl, favoriteUrlHistory),
    [favoriteUrlHistory]
  );
  const collectListUrlOptions = useMemo(
    () => buildUrlHistory(defaultCollectListUrl, collectListUrlHistory),
    [collectListUrlHistory]
  );
  const requestUrlFilterOptions = useMemo(
    () => buildUrlHistory(defaultRequestUrlFilter, requestUrlFilterHistory),
    [requestUrlFilterHistory]
  );

  const { apiUrl, api } = useApi(serverUrl, token);

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

  useDouyinBridge({
    api,
    setDouyinMonitorState,
    setDouyinStatus,
    setDouyinTaskStatusMap,
    setDouyinTaskEvents
  });

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

  useQrRegistration({
    qrRegistration,
    api,
    loadBots,
    setMessage,
    setQrRegistration
  });

  const updateDouyinTask = (taskId: string, patch: Partial<DouyinTask>) => {
    setDouyinTasks((tasks) => tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)));
  };

  const addDouyinTask = () => {
    setDouyinTasks((tasks) => [...tasks, createDefaultTask()]);
  };

  const removeDouyinTask = (taskId: string) => {
    setDouyinTasks((tasks) => tasks.filter((task) => task.id !== taskId));
    setDouyinTaskStatusMap((records) => {
      const next = { ...records };
      delete next[taskId];
      return next;
    });
    setDouyinTaskEvents((records) => {
      const next = { ...records };
      delete next[taskId];
      return next;
    });
  };

  const deleteHistoryValue = (
    currentValue: string,
    setHistory: React.Dispatch<React.SetStateAction<string[]>>
  ) => {
    const target = currentValue.trim();
    if (!target) return;
    setHistory((items) => items.filter((item) => item !== target));
  };

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
      const tasks = activeDouyinTasks.map((task, index) => {
        const normalized: DouyinMonitorTaskPayload = {
          id: task.id,
          favoriteUrl: task.favoriteUrl.trim(),
          collectListUrl: task.collectListUrl.trim(),
          requestUrlFilter: task.requestUrlFilter.trim(),
          clickText: task.clickText.trim(),
          skipClick: task.skipClick
        };
        if (!normalized.favoriteUrl) throw new Error(`任务 ${index + 1} 缺少 favoriteUrl`);
        if (!normalized.collectListUrl) throw new Error(`任务 ${index + 1} 缺少 collectListUrl`);
        if (!normalized.requestUrlFilter) throw new Error(`任务 ${index + 1} 缺少 URL 筛选字符串`);
        if (!normalized.clickText) throw new Error(`任务 ${index + 1} 缺少 clickText`);
        if (!isValidHttpUrl(normalized.favoriteUrl)) throw new Error(`任务 ${index + 1} 的 favoriteUrl 不是有效 URL`);
        if (!isValidHttpUrl(normalized.collectListUrl)) throw new Error(`任务 ${index + 1} 的 collectListUrl 不是有效 URL`);
        return normalized;
      });
      if (tasks.length === 0) {
        setDouyinStatus('请至少启用一个任务');
        return;
      }
      setFavoriteUrlHistory((current) => mergeHistoryValues(defaultFavoriteUrl, current, tasks.map((task) => task.favoriteUrl)));
      setCollectListUrlHistory((current) => mergeHistoryValues(defaultCollectListUrl, current, tasks.map((task) => task.collectListUrl)));
      setRequestUrlFilterHistory((current) => mergeHistoryValues(defaultRequestUrlFilter, current, tasks.map((task) => task.requestUrlFilter)));
      setDouyinTaskStatusMap((records) => {
        const next = { ...records };
        for (const task of tasks) next[task.id] = '等待执行';
        return next;
      });
      console.log('[douyin renderer] start monitor', {
        taskCount: tasks.length,
        hidden: douyinRunHidden,
        showOnClickFailure: douyinShowOnClickFailure,
        shortIntervalSeconds: douyinShortIntervalSeconds,
        longIntervalSeconds: douyinLongIntervalSeconds,
        retryLimit: douyinRetryLimit
      });
      setDouyinStatus(`监听中：共 ${tasks.length} 个活跃任务，按顺序执行`);
      await requireDouyinBridge().startMonitor(tasks, {
        hidden: douyinRunHidden,
        showOnClickFailure: douyinShowOnClickFailure,
        shortIntervalSeconds: douyinShortIntervalSeconds,
        longIntervalSeconds: douyinLongIntervalSeconds,
        retryLimit: douyinRetryLimit
      });
    } catch (error) {
      setDouyinStatus(error instanceof Error ? error.message : '开始监听失败');
    }
  };

  const stopDouyinMonitor = async () => {
    console.log('[douyin renderer] stop monitor');
    await requireDouyinBridge().stopMonitor();
    setDouyinStatus('已停止监听');
  };

  const refreshDouyinNow = async () => {
    try {
      setDouyinStatus('正在立即刷新...');
      await requireDouyinBridge().refreshNow();
    } catch (error) {
      setDouyinStatus(error instanceof Error ? error.message : '立即刷新失败');
    }
  };

  return (
    <main className="app-shell">
      <Title heading={2}>DogeBot</Title>
      {message ? <Alert className="app-message" type="info" content={message} /> : null}

      {!loggedIn ? (
        <LoginCard
          serverUrl={serverUrl}
          setServerUrl={setServerUrl}
          loginForm={loginForm}
          setLoginForm={setLoginForm}
          onLogin={login}
        />
      ) : (
        <>
          <FeishuBotsCard
            botForm={botForm}
            setBotForm={setBotForm}
            onCreateBot={createBot}
            onBeginQrRegistration={beginQrRegistration}
            onLogout={logout}
            qrRegistration={qrRegistration}
            bots={bots}
            connectionMap={connectionMap}
            apiUrl={apiUrl}
            onProbe={probeBot}
            onDelete={deleteBot}
          />

          <DouyinMonitorCard
            douyinShortIntervalSeconds={douyinShortIntervalSeconds}
            setDouyinShortIntervalSeconds={setDouyinShortIntervalSeconds}
            douyinLongIntervalSeconds={douyinLongIntervalSeconds}
            setDouyinLongIntervalSeconds={setDouyinLongIntervalSeconds}
            douyinRetryLimit={douyinRetryLimit}
            setDouyinRetryLimit={setDouyinRetryLimit}
            douyinRunHidden={douyinRunHidden}
            setDouyinRunHidden={setDouyinRunHidden}
            douyinShowOnClickFailure={douyinShowOnClickFailure}
            setDouyinShowOnClickFailure={setDouyinShowOnClickFailure}
            douyinStatus={douyinStatus}
            setDouyinStatus={setDouyinStatus}
            douyinMonitorState={douyinMonitorState}
            onOpenLogin={openDouyinLogin}
            onAddTask={addDouyinTask}
            onStartMonitor={startDouyinMonitor}
            onRefreshNow={refreshDouyinNow}
            onStopMonitor={stopDouyinMonitor}
            douyinTasks={douyinTasks}
            favoriteUrlOptions={favoriteUrlOptions}
            collectListUrlOptions={collectListUrlOptions}
            requestUrlFilterOptions={requestUrlFilterOptions}
            douyinTaskStatusMap={douyinTaskStatusMap}
            douyinTaskEvents={douyinTaskEvents}
            updateDouyinTask={updateDouyinTask}
            removeDouyinTask={removeDouyinTask}
            deleteHistoryValue={deleteHistoryValue}
            setFavoriteUrlHistory={setFavoriteUrlHistory}
            setCollectListUrlHistory={setCollectListUrlHistory}
            setRequestUrlFilterHistory={setRequestUrlFilterHistory}
          />
        </>
      )}
    </main>
  );
}
