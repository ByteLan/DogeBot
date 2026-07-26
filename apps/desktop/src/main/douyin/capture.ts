import { extractAwemeIdsFromBody } from '../../shared/aweme.js';
import { DouyinIpc } from '../../shared/ipc-channels.js';
import type { DouyinTaskConfig } from '../../shared/types.js';
import { logDouyin } from '../log.js';
import { douyinCaptureWaitMs } from './constants.js';
import { DOUYIN_TASK_SEEN_IDS_MAX, state } from './state.js';
import { isCollectListUrl, taskLabel } from './tasks.js';
import type { DouyinRunner, DouyinTaskRunResult } from './types.js';

type CollectListData = { url?: unknown; status?: unknown; body?: unknown; error?: unknown; source?: unknown; receivedAt?: unknown };

export function clearPendingCapture(runner: DouyinRunner, result?: DouyinTaskRunResult) {
  if (!runner.pendingCapture) return;
  clearTimeout(runner.pendingCapture.timer);
  const pending = runner.pendingCapture;
  runner.pendingCapture = undefined;
  if (!pending.settled) {
    pending.settled = true;
    pending.resolve(result || { captured: false, changed: false, awemeIds: [] });
  }
}

function buildCollectListResult(task: DouyinTaskConfig, data: CollectListData) {
  return {
    taskId: task.id,
    taskClickText: task.clickText,
    taskFavoriteUrl: task.favoriteUrl,
    taskCollectListUrl: task.collectListUrl,
    taskRequestUrlFilter: task.requestUrlFilter,
    url: typeof data.url === 'string' ? data.url : task.collectListUrl,
    status: typeof data.status === 'number' ? data.status : Number(data.status || 0),
    body: typeof data.body === 'string' ? data.body : '',
    error: typeof data.error === 'string' ? data.error : undefined,
    source: typeof data.source === 'string' ? data.source : 'page-hook',
    receivedAt: typeof data.receivedAt === 'string' ? data.receivedAt : new Date().toISOString()
  };
}

function checkAndUpdateSeenIds(runner: DouyinRunner, awemeIds: string[]) {
  if (awemeIds.length === 0) return false;
  let seenList = runner.seenIds;
  const seenSet = new Set(seenList);
  const hasNew = awemeIds.some((id) => !seenSet.has(id));
  if (!hasNew) return false;
  for (const id of awemeIds) {
    if (!seenSet.has(id)) {
      seenSet.add(id);
      seenList.push(id);
    }
  }
  if (seenList.length > DOUYIN_TASK_SEEN_IDS_MAX) {
    seenList = seenList.slice(seenList.length - DOUYIN_TASK_SEEN_IDS_MAX);
  }
  runner.seenIds = seenList;
  return true;
}

function emitCollectListResult(runner: DouyinRunner, data: CollectListData) {
  const task = runner.task;
  const result = buildCollectListResult(task, data);
  const awemeIds = result.body ? extractAwemeIdsFromBody(result.body) : [];
  const changed = checkAndUpdateSeenIds(runner, awemeIds);
  logDouyin('collect list response captured', {
    taskId: result.taskId,
    url: result.url,
    status: result.status,
    source: result.source,
    length: result.body.length,
    error: result.error,
    changed,
    awemeCount: awemeIds.length,
    seenCount: runner.seenIds.length
  });
  state.mainWindow?.webContents.send(DouyinIpc.collectsVideoList, { ...result, awemeIds, changed });
  return { changed, awemeIds };
}

// 抓包 payload 已由 event.sender 定位到具体 runner；仍用 URL 二次校验归属该任务。
export function handleCapturedCollectsVideoList(runner: DouyinRunner, payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const data = payload as CollectListData;
  if (typeof data.url !== 'string') {
    logDouyin('ignored collect list payload without url', { taskId: runner.taskId, source: data.source });
    return;
  }
  if (!isCollectListUrl(data.url, runner.task)) {
    logDouyin('ignored collect list payload', { taskId: runner.taskId, url: data.url, source: data.source });
    return;
  }
  const pending = runner.pendingCapture;
  if (!runner.running && !pending) {
    logDouyin('ignored collect list payload while runner stopped', { taskId: runner.taskId, url: data.url });
    return;
  }
  const result = emitCollectListResult(runner, data);
  if (pending) {
    clearPendingCapture(runner, { captured: true, changed: result.changed, awemeIds: result.awemeIds });
  }
}

export function createPendingCapture(runner: DouyinRunner) {
  clearPendingCapture(runner);
  const task = runner.task;
  return new Promise<DouyinTaskRunResult>((resolve) => {
    const timer = setTimeout(() => {
      logDouyin('collect list wait timeout', { taskId: task.id, task: taskLabel(task) });
      state.mainWindow?.webContents.send(DouyinIpc.collectsVideoList, {
        taskId: task.id,
        taskClickText: task.clickText,
        taskFavoriteUrl: task.favoriteUrl,
        taskCollectListUrl: task.collectListUrl,
        taskRequestUrlFilter: task.requestUrlFilter,
        url: task.collectListUrl,
        status: 0,
        error: '等待 collect list 接口返回超时',
        source: 'monitor-timeout',
        receivedAt: new Date().toISOString(),
        awemeIds: []
      });
      clearPendingCapture(runner, { captured: false, changed: false, awemeIds: [] });
    }, douyinCaptureWaitMs);
    runner.pendingCapture = {
      task,
      resolve,
      timer,
      settled: false
    };
  });
}
