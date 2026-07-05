import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, Button, Card, Form, Grid, Input, InputNumber, Link, List, Message, Select, Space, Switch, Tabs, Tag, Typography } from '@arco-design/web-react';
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

type DouyinTask = {
  id: string;
  enabled: boolean;
  favoriteUrl: string;
  collectListUrl: string;
  requestUrlFilter: string;
  clickText: string;
  skipClick: boolean;
};

type DouyinMonitorTaskPayload = {
  id: string;
  favoriteUrl: string;
  collectListUrl: string;
  requestUrlFilter: string;
  clickText: string;
  skipClick: boolean;
};

type DouyinMonitorSharedConfig = {
  hidden?: boolean;
  showOnClickFailure?: boolean;
  shortIntervalSeconds?: number;
  longIntervalSeconds?: number;
  retryLimit?: number;
};

type DouyinBridge = {
  openLogin: () => Promise<void>;
  startMonitor: (tasks: DouyinMonitorTaskPayload[], sharedConfig?: DouyinMonitorSharedConfig) => Promise<void>;
  stopMonitor: () => Promise<void>;
  refreshNow: () => Promise<void>;
  getMonitorState: () => Promise<DouyinMonitorState>;
  setHidden: (hidden: boolean) => Promise<void>;
  onClickResult: (listener: (data: unknown) => void) => () => void;
  onCollectsVideoList: (listener: (data: unknown) => void) => () => void;
  onMonitorState: (listener: (data: DouyinMonitorState) => void) => () => void;
};

type ClipboardContentKind = 'text' | 'image' | 'binary';
type ClipboardFilter = 'all' | ClipboardContentKind;

type ClipboardContentItem = {
  id: string;
  type: string;
  kind: ClipboardContentKind;
  data: string;
  size: number;
  sourceKind?: string;
  fileName?: string;
  unavailable?: boolean;
};

type ClipboardSnapshot = {
  id: string;
  title: string;
  createdAt: number;
  items: ClipboardContentItem[];
  source: 'paste' | 'native';
};

type ClipboardApplyResult = {
  ok: boolean;
  appliedTypes: string[];
  skippedTypes: string[];
  errors: Array<{ type: string; message: string }>;
  verifiedFormats: string[];
  textLength: number;
};

type ClipboardReadResult = {
  ok: boolean;
  title: string;
  createdAt: number;
  items: ClipboardContentItem[];
  formats: string[];
};

type DogeBridge = {
  _tools?: {
    _clipboard?: {
      _read_clipboard_content?: () => Promise<ClipboardReadResult>;
      _apply_clipboard_content?: (
        content: ClipboardSnapshot | { items: ClipboardContentItem[]; strategy?: 'safe' | 'custom-only' } | ClipboardContentItem[]
      ) => Promise<ClipboardApplyResult>;
    };
  };
};

type DouyinEvent = {
  id: string;
  title: string;
  data: unknown;
};

type DouyinCollectResult = {
  taskId?: string;
  taskClickText?: string;
  taskFavoriteUrl?: string;
  taskCollectListUrl?: string;
  taskRequestUrlFilter?: string;
  url?: string;
  status?: number;
  body?: string;
  error?: string;
  source?: string;
  receivedAt?: string;
  awemeIds?: string[];
  changed?: boolean;
};

type DouyinClickResult = {
  taskId?: string;
  taskClickText?: string;
  clicked?: boolean;
  reason?: string;
  text?: string;
  skipped?: boolean;
  clickedAt?: string;
};

type DouyinMonitorState = {
  running: boolean;
  mode: 'short' | 'long';
  currentIntervalSeconds: number;
  shortIntervalSeconds: number;
  longIntervalSeconds: number;
  sameIdsCount: number;
  retryLimit: number;
  nextRunAt: string;
  tickRunning: boolean;
  taskCount: number;
  activeTaskId: string;
  activeTaskLabel: string;
};

declare global {
  interface Window {
    douyin?: DouyinBridge;
    dogeBridge?: DogeBridge;
  }
}

const { Title, Text, Paragraph } = Typography;
const { Row, Col } = Grid;
const initialServerUrl = localStorage.getItem('dogebot.serverUrl') || 'http://127.0.0.1:3000';
const defaultFavoriteUrl = 'https://www.douyin.com/user/self?from_tab_name=main&showSubTab=favorite_folder&showTab=favorite_collection';
const defaultCollectListUrl = 'https://www.douyin.com/aweme/v1/web/collects/video/list/';
const defaultRequestUrlFilter = 'collects_id=7648523880352618283';

function readPositiveNumber(key: string, fallback: number) {
  const parsed = Number(localStorage.getItem(key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function createTaskId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createDefaultTask(partial: Partial<DouyinTask> = {}): DouyinTask {
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

function normalizeStoredTask(value: unknown): DouyinTask | undefined {
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

function readStoredTasks() {
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

function readStoredStringList(key: string, fallback: string[] = []) {
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

function buildUrlHistory(defaultValue: string, values: Array<string | undefined>) {
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

function mergeHistoryValues(defaultValue: string, current: string[], values: Array<string | undefined>) {
  return buildUrlHistory(defaultValue, [...current, ...values]).filter((value) => value !== defaultValue);
}

function isValidHttpUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseCollectListBody(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('body' in data)) return data;
  const record = data as Record<string, unknown>;
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

function appendEventRecord(records: Record<string, DouyinEvent[]>, taskId: string, event: DouyinEvent) {
  return {
    ...records,
    [taskId]: [event, ...(records[taskId] || [])].slice(0, 10)
  };
}

const clipboardStorageKey = 'dogebot.tools.clipboard.snapshots';

function createClipboardId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function getClipboardKind(type: string, sourceKind?: string): ClipboardContentKind {
  if (sourceKind === 'string' || type.startsWith('text/')) return 'text';
  if (type.startsWith('image/')) return 'image';
  return 'binary';
}

function readClipboardString(item: DataTransferItem) {
  return new Promise<string>((resolve) => item.getAsString((value) => resolve(value)));
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function readStoredClipboardSnapshots() {
  const raw = localStorage.getItem(clipboardStorageKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => Array.isArray(item?.items)) as ClipboardSnapshot[] : [];
  } catch {
    return [];
  }
}

function writeStoredClipboardSnapshots(snapshots: ClipboardSnapshot[]) {
  localStorage.setItem(clipboardStorageKey, JSON.stringify(snapshots));
}

function getClipboardKindLabel(kind: ClipboardContentKind) {
  if (kind === 'text') return '文本';
  if (kind === 'image') return '图片';
  return '文件';
}

function getClipboardSnapshotSize(snapshot: ClipboardSnapshot) {
  return snapshot.items.reduce((sum, item) => sum + item.size, 0);
}

function getClipboardSummary(snapshot: ClipboardSnapshot) {
  const counts = snapshot.items.reduce<Record<ClipboardContentKind, number>>((result, item) => {
    result[item.kind] += 1;
    return result;
  }, { text: 0, image: 0, binary: 0 });
  return [
    counts.text ? `${counts.text} 文本` : '',
    counts.image ? `${counts.image} 图片` : '',
    counts.binary ? `${counts.binary} 文件` : ''
  ].filter(Boolean).join(' · ') || '空记录';
}

function snapshotMatches(snapshot: ClipboardSnapshot, query: string, filter: ClipboardFilter) {
  const normalized = query.trim().toLowerCase();
  if (filter !== 'all' && !snapshot.items.some((item) => item.kind === filter)) return false;
  if (!normalized) return true;
  return snapshot.title.toLowerCase().includes(normalized)
    || snapshot.items.some((item) => item.type.toLowerCase().includes(normalized)
      || item.sourceKind?.toLowerCase().includes(normalized)
      || item.fileName?.toLowerCase().includes(normalized)
      || (item.kind === 'text' && item.data.toLowerCase().includes(normalized)));
}

function normalizeClipboardReadResult(result: ClipboardReadResult): ClipboardSnapshot {
  return {
    id: createClipboardId(),
    title: result.title || `系统剪切板 ${new Date().toLocaleString()}`,
    createdAt: result.createdAt || Date.now(),
    items: Array.isArray(result.items) ? result.items : [],
    source: 'native'
  };
}

async function readClipboardPasteSnapshot(clipboardData: DataTransfer): Promise<ClipboardSnapshot> {
  const itemSnapshots: Array<
    { type: string; sourceKind: 'string'; dataPromise: Promise<string> } |
    { type: string; sourceKind: 'file'; file: File }
  > = [];
  const typeSnapshots: Array<{ type: string; data: string }> = [];
  const fileKeys = new Set<string>();
  const capturedTypes = new Set<string>();
  const contents: ClipboardContentItem[] = [];

  for (let index = 0; index < clipboardData.items.length; index += 1) {
    const item = clipboardData.items[index];
    const type = item.type || 'application/octet-stream';
    if (item.kind === 'string') {
      itemSnapshots.push({ type, sourceKind: 'string', dataPromise: readClipboardString(item) });
      continue;
    }
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (!file) continue;
      fileKeys.add(`${file.name}-${file.type}-${file.size}-${file.lastModified}`);
      itemSnapshots.push({ type, sourceKind: 'file', file });
    }
  }

  for (let index = 0; index < clipboardData.files.length; index += 1) {
    const file = clipboardData.files[index];
    const key = `${file.name}-${file.type}-${file.size}-${file.lastModified}`;
    if (fileKeys.has(key)) continue;
    fileKeys.add(key);
    itemSnapshots.push({ type: file.type || 'application/octet-stream', sourceKind: 'file', file });
  }

  for (let index = 0; index < clipboardData.types.length; index += 1) {
    const type = clipboardData.types[index];
    typeSnapshots.push({ type, data: type === 'Files' ? '' : clipboardData.getData(type) });
  }

  for (const item of itemSnapshots) {
    if (item.sourceKind === 'string') {
      const data = await item.dataPromise;
      contents.push({
        id: createClipboardId(),
        type: item.type,
        kind: getClipboardKind(item.type, item.sourceKind),
        data,
        size: new Blob([data], { type: item.type }).size,
        sourceKind: item.sourceKind
      });
      capturedTypes.add(item.type);
      continue;
    }
    const type = item.file.type || item.type;
    contents.push({
      id: createClipboardId(),
      type,
      kind: getClipboardKind(type, item.sourceKind),
      data: await blobToDataUrl(item.file),
      size: item.file.size,
      sourceKind: item.sourceKind,
      fileName: item.file.name || undefined
    });
    capturedTypes.add(type);
    capturedTypes.add(item.type);
  }

  for (const { type, data } of typeSnapshots) {
    if (type === 'Files' || capturedTypes.has(type)) continue;
    contents.push({
      id: createClipboardId(),
      type,
      kind: getClipboardKind(type, 'string'),
      data,
      size: data ? new Blob([data], { type }).size : 0,
      sourceKind: 'string',
      unavailable: !data
    });
  }

  return {
    id: createClipboardId(),
    title: `粘贴 ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    items: contents,
    source: 'paste'
  };
}

function ClipboardItemPreview({
  item,
  onApplyItem
}: {
  item: ClipboardContentItem;
  onApplyItem: (item: ClipboardContentItem, strategy: 'safe' | 'custom-only') => void;
}) {
  return (
    <div className="clipboard-item">
      <div className="clipboard-item-head">
        <Space wrap>
          <Tag color={item.kind === 'text' ? 'green' : item.kind === 'image' ? 'blue' : 'gray'}>{getClipboardKindLabel(item.kind)}</Tag>
          <Text type="secondary">{item.type}</Text>
          {item.sourceKind ? <Text type="secondary">kind: {item.sourceKind}</Text> : null}
          <Text type="secondary">{formatBytes(item.size)}</Text>
          {item.fileName ? <Text type="secondary">{item.fileName}</Text> : null}
        </Space>
        <Space>
          <Button size="mini" disabled={item.unavailable} onClick={() => onApplyItem(item, 'safe')}>标准写入</Button>
          <Button size="mini" disabled={item.unavailable || ['text/plain', 'text/html', 'text/rtf'].includes(item.type)} onClick={() => onApplyItem(item, 'custom-only')}>自定义写入</Button>
        </Space>
      </div>
      {item.kind === 'text' ? (
        <pre className="clipboard-text">{item.unavailable ? '该类型只暴露了 MIME，未开放内容数据' : item.data || '空文本'}</pre>
      ) : null}
      {item.kind === 'image' ? <img className="clipboard-image" src={item.data} alt="clipboard" /> : null}
      {item.kind === 'binary' ? <div className="clipboard-binary">二进制内容已保存</div> : null}
    </div>
  );
}

function ClipboardSnapshotCard({
  snapshot,
  onApply,
  onDelete,
  onRename
}: {
  snapshot: ClipboardSnapshot;
  onApply: (snapshot: ClipboardSnapshot, strategy: 'safe' | 'custom-only') => void;
  onDelete?: (id: string) => void;
  onRename?: (snapshot: ClipboardSnapshot) => void;
}) {
  const totalBytes = getClipboardSnapshotSize(snapshot);
  return (
    <Card
      className="clipboard-snapshot"
      title={snapshot.title}
      extra={(
        <Space>
          <Button size="small" type="primary" onClick={() => onApply(snapshot, 'safe')}>标准写入</Button>
          <Button size="small" onClick={() => onApply(snapshot, 'custom-only')}>自定义 MIME 写入</Button>
          {onRename ? <Button size="small" onClick={() => onRename(snapshot)}>重命名</Button> : null}
          {onDelete ? <Button size="small" status="danger" onClick={() => onDelete(snapshot.id)}>删除</Button> : null}
        </Space>
      )}
    >
      <Space className="clipboard-meta" wrap>
        <Text type="secondary">{snapshot.items.length} 项</Text>
        <Text type="secondary">{getClipboardSummary(snapshot)}</Text>
        <Text type="secondary">{formatBytes(totalBytes)}</Text>
        <Text type="secondary">{new Date(snapshot.createdAt).toLocaleString()}</Text>
      </Space>
      <div className="clipboard-items">
        {snapshot.items.map((item) => (
          <ClipboardItemPreview
            key={item.id}
            item={item}
            onApplyItem={(nextItem, strategy) => onApply({ ...snapshot, items: [nextItem] }, strategy)}
          />
        ))}
      </div>
    </Card>
  );
}

function ClipboardToolWindow() {
  const [snapshots, setSnapshots] = useState<ClipboardSnapshot[]>(() => readStoredClipboardSnapshots());
  const [currentSnapshot, setCurrentSnapshot] = useState<ClipboardSnapshot | undefined>();
  const [status, setStatus] = useState(window.dogeBridge?._tools?._clipboard?._apply_clipboard_content ? '剪切板 native bridge 已连接' : '剪切板 native bridge 未加载');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ClipboardFilter>('all');
  const [saveTitle, setSaveTitle] = useState('');
  const [renamingId, setRenamingId] = useState('');
  const [renameTitle, setRenameTitle] = useState('');

  const filteredSnapshots = useMemo(
    () => snapshots.filter((snapshot) => snapshotMatches(snapshot, query, filter)),
    [filter, query, snapshots]
  );

  const persistSnapshots = useCallback((nextSnapshots: ClipboardSnapshot[]) => {
    writeStoredClipboardSnapshots(nextSnapshots);
    setSnapshots(nextSnapshots);
  }, []);

  const handlePaste = useCallback(async (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const snapshot = await readClipboardPasteSnapshot(event.clipboardData);
    setCurrentSnapshot(snapshot);
    setSaveTitle(snapshot.title);
    setStatus(`已捕获 ${snapshot.items.length} 项内容`);
  }, []);

  const readSystemClipboard = useCallback(async () => {
    const read = window.dogeBridge?._tools?._clipboard?._read_clipboard_content;
    if (!read) {
      setStatus('native bridge 未加载，无法读取系统剪切板');
      return;
    }
    try {
      const snapshot = normalizeClipboardReadResult(await read());
      setCurrentSnapshot(snapshot);
      setSaveTitle(snapshot.title);
      setStatus(`已读取系统剪切板：${snapshot.items.length} 项`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '读取系统剪切板失败');
    }
  }, []);

  const saveCurrent = useCallback(() => {
    if (!currentSnapshot || currentSnapshot.items.length === 0) {
      setStatus('没有可保存的内容');
      return;
    }
    const nextSnapshot = {
      ...currentSnapshot,
      id: createClipboardId(),
      title: saveTitle.trim() || currentSnapshot.title,
      createdAt: Date.now()
    };
    persistSnapshots([nextSnapshot, ...snapshots]);
    setStatus('已保存到本地');
  }, [currentSnapshot, persistSnapshots, saveTitle, snapshots]);

  const applySnapshot = useCallback(async (snapshot: ClipboardSnapshot, strategy: 'safe' | 'custom-only') => {
    const apply = window.dogeBridge?._tools?._clipboard?._apply_clipboard_content;
    if (!apply) {
      Message.error('native bridge 未加载，无法写入系统剪切板');
      return;
    }
    try {
      const result = await apply({ items: snapshot.items, strategy });
      const errors = result.errors.length ? `；错误：${result.errors.map((item) => `${item.type}: ${item.message}`).join('；')}` : '';
      const skipped = result.skippedTypes.length ? `；跳过：${result.skippedTypes.join('、')}` : '';
      const verified = result.verifiedFormats.length ? `；系统格式：${result.verifiedFormats.join('、')}` : '';
      const message = `${strategy === 'custom-only' ? '自定义 MIME' : '标准'}${result.ok ? '写入成功' : '写入失败'}：${result.appliedTypes.join('、') || '无'}${skipped}${errors}${verified}`;
      if (result.ok) {
        Message.info(message);
        return;
      }
      Message.error(message);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '写入系统剪切板失败');
    }
  }, []);

  const deleteSnapshot = useCallback((id: string) => {
    persistSnapshots(snapshots.filter((snapshot) => snapshot.id !== id));
  }, [persistSnapshots, snapshots]);

  const startRename = useCallback((snapshot: ClipboardSnapshot) => {
    setRenamingId(snapshot.id);
    setRenameTitle(snapshot.title);
  }, []);

  const commitRename = useCallback(() => {
    const title = renameTitle.trim();
    if (!renamingId || !title) return;
    persistSnapshots(snapshots.map((snapshot) => snapshot.id === renamingId ? { ...snapshot, title } : snapshot));
    setRenamingId('');
    setRenameTitle('');
  }, [persistSnapshots, renameTitle, renamingId, snapshots]);

  return (
    <main className="clipboard-window-shell">
      <Title heading={2}>剪切板工具</Title>
      <Alert className="clipboard-status" type="info" content={status} />

      <Card title="粘贴捕获">
        <Space className="clipboard-toolbar" wrap>
          <Button type="primary" onClick={readSystemClipboard}>读取系统剪切板</Button>
          <Input value={saveTitle} placeholder="记录名称" onChange={setSaveTitle} style={{ width: 280 }} />
          <Button type="primary" onClick={saveCurrent} disabled={!currentSnapshot}>保存当前内容</Button>
        </Space>
        <div className="clipboard-paste-target" tabIndex={0} onPaste={handlePaste}>
          <Text bold>Ctrl + V</Text>
          <Text type="secondary">捕获文本、图片、文件和自定义 MIME</Text>
        </div>
        {currentSnapshot ? (
          <ClipboardSnapshotCard snapshot={currentSnapshot} onApply={applySnapshot} />
        ) : (
          <div className="clipboard-empty">暂无捕获内容</div>
        )}
      </Card>

      <Card title="本地记录">
        <div className="clipboard-library-tools">
          <Input value={query} placeholder="搜索名称、文本内容或 MIME" onChange={setQuery} />
          <Select value={filter} onChange={(value) => setFilter(String(value) as ClipboardFilter)} style={{ width: 140 }}>
            <Select.Option value="all">全部</Select.Option>
            <Select.Option value="text">文本</Select.Option>
            <Select.Option value="image">图片</Select.Option>
            <Select.Option value="binary">文件</Select.Option>
          </Select>
          <Button status="danger" disabled={snapshots.length === 0} onClick={() => persistSnapshots([])}>清空</Button>
        </div>
        {renamingId ? (
          <div className="clipboard-rename-row">
            <Input value={renameTitle} placeholder="记录名称" onChange={setRenameTitle} />
            <Button type="primary" onClick={commitRename}>保存名称</Button>
            <Button onClick={() => setRenamingId('')}>取消</Button>
          </div>
        ) : null}
        {filteredSnapshots.length === 0 ? (
          <div className="clipboard-empty">暂无保存记录</div>
        ) : (
          <Space direction="vertical" className="clipboard-snapshot-list">
            {filteredSnapshots.map((snapshot) => (
              <ClipboardSnapshotCard
                key={snapshot.id}
                snapshot={snapshot}
                onApply={applySnapshot}
                onDelete={deleteSnapshot}
                onRename={startRename}
              />
            ))}
          </Space>
        )}
      </Card>
    </main>
  );
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
  const [douyinTasks, setDouyinTasks] = useState<DouyinTask[]>(() => readStoredTasks());
  const [favoriteUrlHistory, setFavoriteUrlHistory] = useState<string[]>(() => readStoredStringList('dogebot.douyinFavoriteUrlHistory'));
  const [collectListUrlHistory, setCollectListUrlHistory] = useState<string[]>(() => readStoredStringList('dogebot.douyinCollectListUrlHistory'));
  const [requestUrlFilterHistory, setRequestUrlFilterHistory] = useState<string[]>(() => readStoredStringList('dogebot.douyinRequestUrlFilterHistory'));
  const [douyinRunHidden, setDouyinRunHidden] = useState(() => localStorage.getItem('dogebot.douyinRunHidden') === '1');
  const [douyinShowOnClickFailure, setDouyinShowOnClickFailure] = useState(() => localStorage.getItem('dogebot.douyinShowOnClickFailure') === '1');
  const [douyinShortIntervalSeconds, setDouyinShortIntervalSeconds] = useState(() => readPositiveNumber('dogebot.douyinShortIntervalSeconds', 10));
  const [douyinLongIntervalSeconds, setDouyinLongIntervalSeconds] = useState(() => readPositiveNumber('dogebot.douyinLongIntervalSeconds', 60));
  const [douyinRetryLimit, setDouyinRetryLimit] = useState(() => readPositiveNumber('dogebot.douyinRetryLimit', 3));
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

  useEffect(() => {
    localStorage.setItem('dogebot.douyinTasks', JSON.stringify(douyinTasks));
  }, [douyinTasks]);

  useEffect(() => {
    localStorage.setItem('dogebot.douyinFavoriteUrlHistory', JSON.stringify(favoriteUrlHistory));
  }, [favoriteUrlHistory]);

  useEffect(() => {
    localStorage.setItem('dogebot.douyinCollectListUrlHistory', JSON.stringify(collectListUrlHistory));
  }, [collectListUrlHistory]);

  useEffect(() => {
    localStorage.setItem('dogebot.douyinRequestUrlFilterHistory', JSON.stringify(requestUrlFilterHistory));
  }, [requestUrlFilterHistory]);

  useEffect(() => {
    localStorage.setItem('dogebot.douyinRunHidden', douyinRunHidden ? '1' : '0');
  }, [douyinRunHidden]);

  useEffect(() => {
    localStorage.setItem('dogebot.douyinShowOnClickFailure', douyinShowOnClickFailure ? '1' : '0');
  }, [douyinShowOnClickFailure]);

  useEffect(() => {
    localStorage.setItem('dogebot.douyinShortIntervalSeconds', String(douyinShortIntervalSeconds));
  }, [douyinShortIntervalSeconds]);

  useEffect(() => {
    localStorage.setItem('dogebot.douyinLongIntervalSeconds', String(douyinLongIntervalSeconds));
  }, [douyinLongIntervalSeconds]);

  useEffect(() => {
    localStorage.setItem('dogebot.douyinRetryLimit', String(douyinRetryLimit));
  }, [douyinRetryLimit]);

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
    window.douyin.getMonitorState().then(setDouyinMonitorState).catch((error) => console.error('[douyin renderer] get monitor state failed', error));

    const addTaskEvent = (taskId: string, title: string, data: unknown) => {
      const event: DouyinEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        data
      };
      setDouyinTaskEvents((records) => appendEventRecord(records, taskId, event));
    };

    const offClick = window.douyin.onClickResult((data) => {
      const result = data as DouyinClickResult;
      const taskId = typeof result.taskId === 'string' ? result.taskId : '';
      if (!taskId) return;
      const taskText = result.taskClickText || '未命名任务';
      const messageText = result.skipped
        ? '已刷新页面并跳过点击，继续等待接口返回'
        : result.clicked
          ? `已点击：${result.text || taskText}`
          : `点击失败：${result.reason || '未知原因'}`;
      setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: messageText }));
      setDouyinStatus(`${taskText}：${messageText}`);
    });

    const offList = window.douyin.onCollectsVideoList((data) => {
      const payload = data as DouyinCollectResult;
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : '';
      if (!taskId) return;
      const isTimeoutEvent = payload.source === 'monitor-timeout';
      const body = parseCollectListBody(payload);
      const awemeIds = Array.isArray(payload.awemeIds)
        ? payload.awemeIds.map((id) => String(id || '').trim()).filter(Boolean)
        : extractAwemeIds(body);
      const taskText = payload.taskClickText || '未命名任务';
      if (!isTimeoutEvent) {
        addTaskEvent(taskId, `${taskText} · ${payload.url || payload.taskCollectListUrl || 'collects/video/list'}`, body ?? payload);
      }
      if (payload.error) {
        const errorText = isTimeoutEvent ? payload.error : `接口捕获失败：${payload.error}`;
        setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: errorText }));
        setDouyinStatus(`${taskText}：${errorText}`);
        return;
      }
      if (awemeIds.length === 0) {
        const emptyText = '接口已返回，但未提取到 aweme_id';
        setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: emptyText }));
        setDouyinStatus(`${taskText}：${emptyText}`);
        return;
      }
      if (payload.changed === false) {
        const skipText = `已收集 ${awemeIds.length} 个 aweme_id，全部已见过，跳过上传`;
        setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: skipText }));
        setDouyinStatus(`${taskText}：${skipText}`);
        return;
      }
      api<{ inserted: number; total: number }>('/api/douyin/aweme-records', {
        method: 'POST',
        body: JSON.stringify({ clickText: taskText, awemeIds })
      })
        .then((result) => {
          const successText = `已同步 ${awemeIds.length} 个 aweme_id，新增 ${result.inserted} 个，当前累计 ${result.total} 个`;
          setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: successText }));
          setDouyinStatus(`${taskText}：${successText}`);
        })
        .catch((error) => {
          console.error('[douyin renderer] upload aweme ids failed', error);
          const errorText = error instanceof Error ? `同步 aweme_id 失败：${error.message}` : '同步 aweme_id 失败';
          setDouyinTaskStatusMap((records) => ({ ...records, [taskId]: errorText }));
          setDouyinStatus(`${taskText}：${errorText}`);
        });
    });

    const offState = window.douyin.onMonitorState(setDouyinMonitorState);
    return () => {
      offClick();
      offList();
      offState();
    };
  }, [api]);

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
                      description={(
                        <Space direction="vertical" size={2}>
                          <Text type="secondary">{bot.botName || '未探测'} · {bot.domain}</Text>
                          <Text>长连接: {status}{error}</Text>
                          <Text>Webhook: <code>{apiUrl(bot.webhookPath)}</code></Text>
                        </Space>
                      )}
                    />
                  </List.Item>
                );
              }}
            />
          </Card>

          <Card title="抖音收藏监听">
            <Paragraph type="secondary">
              登录态保存在本机 Electron 持久会话中。共享配置包括刷新间隔、retry、隐藏窗口和点击失败后是否弹到前台；每个活跃任务会按顺序执行，并各自维护接口返回日志。
            </Paragraph>
            <Form layout="vertical">
              <Row gutter={12}>
                <Col span={8}>
                  <Form.Item label="短间隔（秒）">
                    <InputNumber min={1} precision={0} value={douyinShortIntervalSeconds} onChange={(value) => setDouyinShortIntervalSeconds(Number(value) > 0 ? Number(value) : 10)} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="长间隔（秒）">
                    <InputNumber min={1} precision={0} value={douyinLongIntervalSeconds} onChange={(value) => setDouyinLongIntervalSeconds(Number(value) > 0 ? Number(value) : 60)} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="retry 次数">
                    <InputNumber min={1} precision={0} value={douyinRetryLimit} onChange={(value) => setDouyinRetryLimit(Number(value) > 0 ? Number(value) : 3)} />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label="执行方式">
                <Space direction="vertical" align="start">
                  <Space>
                    <Switch
                      checked={douyinRunHidden}
                      onChange={(checked) => {
                        setDouyinRunHidden(checked);
                        window.douyin?.setHidden(checked).catch((error) => {
                          console.error('[douyin renderer] set hidden failed', error);
                          setDouyinStatus(error instanceof Error ? error.message : '切换 Douyin 窗口显示状态失败');
                        });
                      }}
                    />
                    <Text type="secondary">{douyinRunHidden ? '隐藏 Douyin 窗口后台执行' : '显示 Douyin 窗口前台执行'}</Text>
                  </Space>
                  <Space>
                    <Switch checked={douyinShowOnClickFailure} onChange={setDouyinShowOnClickFailure} />
                    <Text type="secondary">点击失败立即弹到前台</Text>
                  </Space>
                </Space>
              </Form.Item>
              <Space>
                <Button type="primary" onClick={openDouyinLogin}>登录 douyin.com</Button>
                <Button onClick={addDouyinTask}>新增任务</Button>
                <Button onClick={startDouyinMonitor}>开始监听</Button>
                <Button onClick={refreshDouyinNow} disabled={!douyinMonitorState.running || douyinMonitorState.tickRunning}>立即刷新</Button>
                <Button onClick={stopDouyinMonitor}>停止监听</Button>
              </Space>
            </Form>
            <Alert
              className="douyin-status"
              type="info"
              content={(
                <Space direction="vertical" size={2}>
                  <Text>{douyinStatus}</Text>
                  <Text>
                    当前刷新间隔：{douyinMonitorState.currentIntervalSeconds}s（{douyinMonitorState.mode === 'short' ? '短间隔' : '长间隔'}）；
                    retry：{douyinMonitorState.sameIdsCount}/{douyinMonitorState.retryLimit}；
                    活跃任务：{douyinMonitorState.taskCount}；
                    状态：{douyinMonitorState.tickRunning ? '刷新中' : douyinMonitorState.running ? '等待下次刷新' : '未运行'}
                    {douyinMonitorState.activeTaskLabel ? `；当前任务：${douyinMonitorState.activeTaskLabel}` : ''}
                    {douyinMonitorState.nextRunAt ? `；下次刷新：${new Date(douyinMonitorState.nextRunAt).toLocaleString()}` : ''}
                  </Text>
                </Space>
              )}
            />

            <Space direction="vertical" className="douyin-task-list">
              {douyinTasks.map((task, index) => {
                const taskEvents = douyinTaskEvents[task.id] || [];
                return (
                  <Card
                    key={task.id}
                    className="douyin-task-card"
                    title={`任务 ${index + 1}`}
                    extra={(
                      <Space>
                        <Switch checked={task.enabled} onChange={(enabled) => updateDouyinTask(task.id, { enabled })} />
                        <Text type="secondary">{task.enabled ? '活跃' : '停用'}</Text>
                        <Button size="mini" status="danger" onClick={() => removeDouyinTask(task.id)}>删除</Button>
                      </Space>
                    )}
                  >
                    <Form layout="vertical">
                      <Row gutter={12}>
                        <Col span={12}>
                          <Form.Item label="favoriteUrl">
                            <div className="history-select-row">
                              <div className="history-select-main">
                                <Select
                                  showSearch
                                  allowCreate
                                  value={task.favoriteUrl}
                                  placeholder="请输入或选择历史 favoriteUrl"
                                  onChange={(value) => updateDouyinTask(task.id, { favoriteUrl: String(value || '') })}
                                >
                                  {favoriteUrlOptions.map((option) => (
                                    <Select.Option key={option} value={option}>
                                      {option}
                                    </Select.Option>
                                  ))}
                                </Select>
                              </div>
                              <Button size="mini" onClick={() => deleteHistoryValue(task.favoriteUrl, setFavoriteUrlHistory)}>删除历史</Button>
                            </div>
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item label="collectListUrl">
                            <div className="history-select-row">
                              <div className="history-select-main">
                                <Select
                                  showSearch
                                  allowCreate
                                  value={task.collectListUrl}
                                  placeholder="请输入或选择历史 collectListUrl"
                                  onChange={(value) => updateDouyinTask(task.id, { collectListUrl: String(value || '') })}
                                >
                                  {collectListUrlOptions.map((option) => (
                                    <Select.Option key={option} value={option}>
                                      {option}
                                    </Select.Option>
                                  ))}
                                </Select>
                              </div>
                              <Button size="mini" onClick={() => deleteHistoryValue(task.collectListUrl, setCollectListUrlHistory)}>删除历史</Button>
                            </div>
                          </Form.Item>
                        </Col>
                      </Row>
                      <Row gutter={12}>
                        <Col span={12}>
                          <Form.Item label="请求 URL 筛选字符串">
                            <div className="history-select-row">
                              <div className="history-select-main">
                                <Select
                                  showSearch
                                  allowCreate
                                  value={task.requestUrlFilter}
                                  placeholder="请输入或选择历史请求 URL 筛选字符串"
                                  onChange={(value) => updateDouyinTask(task.id, { requestUrlFilter: String(value || defaultRequestUrlFilter) })}
                                >
                                  {requestUrlFilterOptions.map((option) => (
                                    <Select.Option key={option} value={option}>
                                      {option}
                                    </Select.Option>
                                  ))}
                                </Select>
                              </div>
                              <Button size="mini" onClick={() => deleteHistoryValue(task.requestUrlFilter, setRequestUrlFilterHistory)}>删除历史</Button>
                            </div>
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item label="clickText">
                            <Input value={task.clickText} onChange={(value) => updateDouyinTask(task.id, { clickText: value })} />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item label="执行动作">
                        <Space>
                          <Switch checked={task.skipClick} onChange={(skipClick) => updateDouyinTask(task.id, { skipClick })} />
                          <Text type="secondary">{task.skipClick ? '不点击，仅刷新页面并监听 API' : '刷新页面后点击 clickText'}</Text>
                        </Space>
                      </Form.Item>
                    </Form>
                    <Paragraph className="douyin-task-status" type="secondary">
                      当前状态：{douyinTaskStatusMap[task.id] || '未开始'}
                    </Paragraph>
                    <Title heading={6}>接口返回</Title>
                    {taskEvents.length === 0 ? (
                      <div className="json-empty">暂无</div>
                    ) : (
                      <Space direction="vertical" className="json-list">
                        {taskEvents.map((event) => (
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
                );
              })}
            </Space>
          </Card>
        </>
      )}
    </main>
  );
}

const windowMode = new URLSearchParams(window.location.search).get('window');

createRoot(document.getElementById('root')!).render(
  windowMode === 'clipboard-tool' ? <ClipboardToolWindow /> : <App />
);
