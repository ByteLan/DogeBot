import { extractAwemeIdsFromBody } from '../../shared/aweme.js';
import { DouyinIpc } from '../../shared/ipc-channels.js';
import type { DouyinTaskConfig } from '../../shared/types.js';
import { logDouyin } from '../log.js';
import { douyinCaptureWaitMs } from './constants.js';
import { DOUYIN_TASK_SEEN_IDS_MAX, douyinTaskSeenIds, state } from './state.js';
import { isCollectListUrl, taskLabel } from './tasks.js';
import type { DouyinTaskRunResult } from './types.js';

type CollectListData = { url?: unknown; status?: unknown; body?: unknown; error?: unknown; source?: unknown; receivedAt?: unknown };

export function clearPendingCapture(result?: DouyinTaskRunResult) {
  if (!state.douyinPendingCapture) return;
  clearTimeout(state.douyinPendingCapture.timer);
  const pending = state.douyinPendingCapture;
  state.douyinPendingCapture = undefined;
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

function findMatchedTaskByUrl(url: string, preferredTask?: DouyinTaskConfig) {
  if (preferredTask && isCollectListUrl(url, preferredTask)) return preferredTask;
  return state.douyinTasks.find((task) => isCollectListUrl(url, task));
}

function checkAndUpdateSeenIds(taskId: string, awemeIds: string[]) {
  if (awemeIds.length === 0) return false;
  let seenList = douyinTaskSeenIds.get(taskId) || [];
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
  douyinTaskSeenIds.set(taskId, seenList);
  return true;
}

function emitCollectListResult(task: DouyinTaskConfig, data: CollectListData) {
  const result = buildCollectListResult(task, data);
  const awemeIds = result.body ? extractAwemeIdsFromBody(result.body) : [];
  const changed = checkAndUpdateSeenIds(task.id, awemeIds);
  logDouyin('collect list response captured', {
    taskId: result.taskId,
    url: result.url,
    status: result.status,
    source: result.source,
    length: result.body.length,
    error: result.error,
    changed,
    awemeCount: awemeIds.length,
    seenCount: (douyinTaskSeenIds.get(task.id) || []).length
  });
  state.mainWindow?.webContents.send(DouyinIpc.collectsVideoList, { ...result, awemeIds, changed });
  return { changed, awemeIds };
}

export function handleCapturedCollectsVideoList(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const data = payload as CollectListData;
  const pending = state.douyinPendingCapture;
  if (typeof data.url !== 'string') {
    logDouyin('ignored collect list payload without url', { source: data.source });
    return;
  }
  const matchedTask = findMatchedTaskByUrl(data.url, pending?.task);
  if (!matchedTask) {
    logDouyin('ignored collect list payload', { url: data.url, source: data.source });
    return;
  }
  if (!state.douyinMonitorRunning && (!pending || matchedTask.id !== pending.task.id)) {
    logDouyin('ignored collect list payload while monitor stopped', { url: data.url, taskId: matchedTask.id });
    return;
  }
  const result = emitCollectListResult(matchedTask, data);
  if (pending && matchedTask.id === pending.task.id) {
    clearPendingCapture({ captured: true, changed: result.changed, awemeIds: result.awemeIds });
  }
}

export function createPendingCapture(task: DouyinTaskConfig) {
  clearPendingCapture();
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
      clearPendingCapture({ captured: false, changed: false, awemeIds: [] });
    }, douyinCaptureWaitMs);
    state.douyinPendingCapture = {
      task,
      resolve,
      timer,
      settled: false
    };
  });
}
