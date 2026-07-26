import type { BrowserWindow } from 'electron';
import { DouyinIpc } from '../../shared/ipc-channels.js';
import type { DouyinTaskConfig } from '../../shared/types.js';
import { logDouyin } from '../log.js';
import { updateTrayMenu } from '../tray.js';
import { douyinPageReadyWaitMs, douyinPostTaskPauseMs, douyinUserAgent } from './constants.js';
import { clearPendingCapture, createPendingCapture } from './capture.js';
import { state } from './state.js';
import { taskLabel, wait } from './tasks.js';
import { ensureDouyinWindow, showDouyinWindowNow } from './window.js';

export function currentMonitorIntervalMs() {
  return state.douyinIntervalMode === 'long' ? state.douyinLongIntervalMs : state.douyinShortIntervalMs;
}

export function currentMonitorState() {
  return {
    running: state.douyinMonitorRunning,
    mode: state.douyinIntervalMode,
    currentIntervalSeconds: Math.round(currentMonitorIntervalMs() / 1000),
    shortIntervalSeconds: Math.round(state.douyinShortIntervalMs / 1000),
    longIntervalSeconds: Math.round(state.douyinLongIntervalMs / 1000),
    sameIdsCount: state.douyinSameIdsCount,
    retryLimit: state.douyinRetryLimit,
    nextRunAt: state.douyinNextRunAt,
    tickRunning: state.douyinTickRunning,
    taskCount: state.douyinTasks.length,
    activeTaskId: state.douyinCurrentTaskId,
    activeTaskLabel: state.douyinCurrentTaskLabel
  };
}

export function sendMonitorState() {
  state.mainWindow?.webContents.send(DouyinIpc.monitorState, currentMonitorState());
  updateTrayMenu();
}

export function resetMonitorIntervalState() {
  state.douyinIntervalMode = 'short';
  state.douyinSameIdsCount = 0;
}

export function setCurrentTask(task?: DouyinTaskConfig) {
  state.douyinCurrentTaskId = task?.id || '';
  state.douyinCurrentTaskLabel = task ? taskLabel(task) : '';
  sendMonitorState();
}

async function clickTextOnPage(win: BrowserWindow, task: DouyinTaskConfig) {
  if (!task.clickText.trim()) {
    logDouyin('skip click: empty text', { taskId: task.id });
    return;
  }
  logDouyin('click text on page', { taskId: task.id, clickText: task.clickText.trim() });
  const result = await win.webContents.executeJavaScript(
    `
      (() => {
        const keyword = ${JSON.stringify(task.clickText.trim())};
        const candidates = Array.from(document.querySelectorAll('p'));
        const target = candidates.find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (element.textContent || '').includes(keyword);
        });
        if (!target) return { clicked: false, reason: '未找到匹配 p 标签' };
        target.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = target.getBoundingClientRect();
        const chain = [];
        let current = target;
        while (current && chain.length < 5) {
          chain.push({
            tag: current.tagName.toLowerCase(),
            role: current.getAttribute('role'),
            className: typeof current.className === 'string' ? current.className : '',
            text: (current.textContent || '').trim().slice(0, 80)
          });
          current = current.parentElement;
        }
        return {
          clicked: true,
          text: (target.textContent || '').trim().slice(0, 120),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          chain
        };
      })()
    `
  ) as { clicked?: boolean; reason?: string; text?: string; x?: number; y?: number };
  if (result.clicked && typeof result.x === 'number' && typeof result.y === 'number') {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: result.x, y: result.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: result.x, y: result.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: result.x, y: result.y, button: 'left', clickCount: 1 });
  } else if (state.douyinShowOnClickFailure) {
    showDouyinWindowNow(win);
  }
  logDouyin('click result', { taskId: task.id, ...result });
  state.mainWindow?.webContents.send(DouyinIpc.clickResult, {
    taskId: task.id,
    taskClickText: task.clickText,
    ...result,
    clickedAt: new Date().toISOString()
  });
}

async function runSingleTask(task: DouyinTaskConfig) {
  const win = ensureDouyinWindow();
  setCurrentTask(task);
  const capturePromise = createPendingCapture(task);
  await win.loadURL(task.favoriteUrl, { userAgent: douyinUserAgent });
  await wait(douyinPageReadyWaitMs);
  if (task.skipClick) {
    state.mainWindow?.webContents.send(DouyinIpc.clickResult, {
      taskId: task.id,
      taskClickText: task.clickText,
      clicked: true,
      text: task.clickText,
      skipped: true,
      clickedAt: new Date().toISOString()
    });
  } else {
    await clickTextOnPage(win, task).catch((error) => {
      if (state.douyinShowOnClickFailure) showDouyinWindowNow(win);
      state.mainWindow?.webContents.send(DouyinIpc.clickResult, {
        taskId: task.id,
        taskClickText: task.clickText,
        clicked: false,
        reason: error instanceof Error ? error.message : '模拟点击失败',
        clickedAt: new Date().toISOString()
      });
    });
  }
  const result = await capturePromise;
  await wait(douyinPostTaskPauseMs);
  return result;
}

export function scheduleMonitorTick() {
  if (!state.douyinMonitorRunning) return;
  if (state.monitorTimer) clearTimeout(state.monitorTimer);
  const delayMs = currentMonitorIntervalMs();
  state.douyinNextRunAt = new Date(Date.now() + delayMs).toISOString();
  state.monitorTimer = setTimeout(() => void runMonitorTick(), delayMs);
  sendMonitorState();
  logDouyin('monitor next tick scheduled', {
    mode: state.douyinIntervalMode,
    delayMs,
    sameIdsCount: state.douyinSameIdsCount,
    retryLimit: state.douyinRetryLimit,
    taskCount: state.douyinTasks.length
  });
}

export async function runMonitorTick() {
  if (!state.douyinMonitorRunning) return;
  if (state.douyinTickRunning) {
    logDouyin('monitor tick skipped: already running');
    return;
  }
  state.douyinTickRunning = true;
  state.douyinNextRunAt = '';
  sendMonitorState();
  logDouyin('monitor tick start', { taskCount: state.douyinTasks.length });
  let hasChanged = false;
  try {
    const tasks = [...state.douyinTasks];
    if (tasks.length === 0) {
      stopMonitor();
      return;
    }
    for (const task of tasks) {
      if (!state.douyinMonitorRunning) break;
      const result = await runSingleTask(task);
      if (result.changed) hasChanged = true;
    }
    if (hasChanged) {
      state.douyinIntervalMode = 'short';
      state.douyinSameIdsCount = 0;
    } else {
      state.douyinSameIdsCount = Math.min(state.douyinSameIdsCount + 1, state.douyinRetryLimit);
      if (state.douyinSameIdsCount >= state.douyinRetryLimit) state.douyinIntervalMode = 'long';
    }
    logDouyin('monitor tick done', {
      taskCount: tasks.length,
      hasChanged,
      mode: state.douyinIntervalMode,
      sameIdsCount: state.douyinSameIdsCount
    });
  } finally {
    clearPendingCapture();
    state.douyinTickRunning = false;
    setCurrentTask(undefined);
    if (state.douyinMonitorRunning) scheduleMonitorTick();
  }
}

export function stopMonitor() {
  state.douyinMonitorRunning = false;
  if (state.monitorTimer) clearTimeout(state.monitorTimer);
  state.monitorTimer = undefined;
  state.douyinNextRunAt = '';
  clearPendingCapture();
  setCurrentTask(undefined);
  sendMonitorState();
  logDouyin('monitor stopped');
}
