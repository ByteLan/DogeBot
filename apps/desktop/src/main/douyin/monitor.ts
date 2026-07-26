import type { BrowserWindow } from 'electron';
import { DouyinIpc } from '../../shared/ipc-channels.js';
import type { DouyinTaskConfig, DouyinTaskState } from '../../shared/types.js';
import { logDouyin } from '../log.js';
import { updateTrayMenu } from '../tray.js';
import { douyinPageReadyWaitMs, douyinPostTaskPauseMs, douyinUserAgent } from './constants.js';
import { clearPendingCapture, createPendingCapture } from './capture.js';
import { state } from './state.js';
import { taskLabel, wait } from './tasks.js';
import { applyRunnerVisibility, ensureRunnerWindow, showDouyinWindowNow, syncRunnerCaptureConfig } from './window.js';
import type { DouyinRunner } from './types.js';

function currentRunnerIntervalMs(runner: DouyinRunner) {
  const seconds = runner.intervalMode === 'long' ? runner.task.longIntervalSeconds : runner.task.shortIntervalSeconds;
  return seconds * 1000;
}

export function currentTaskState(runner: DouyinRunner): DouyinTaskState {
  return {
    taskId: runner.taskId,
    running: runner.running,
    mode: runner.intervalMode,
    currentIntervalSeconds: Math.round(currentRunnerIntervalMs(runner) / 1000),
    shortIntervalSeconds: runner.task.shortIntervalSeconds,
    longIntervalSeconds: runner.task.longIntervalSeconds,
    sameIdsCount: runner.sameIdsCount,
    retryLimit: runner.task.retryLimit,
    nextRunAt: runner.nextRunAt,
    tickRunning: runner.tickRunning,
    windowOpen: Boolean(runner.window && !runner.window.isDestroyed()),
    hidden: runner.runHidden,
    activeTaskLabel: runner.tickRunning ? taskLabel(runner.task) : ''
  };
}

export function collectTasksState() {
  const states: Record<string, DouyinTaskState> = {};
  for (const runner of state.runners.values()) {
    states[runner.taskId] = currentTaskState(runner);
  }
  return states;
}

export function sendTasksState() {
  state.mainWindow?.webContents.send(DouyinIpc.tasksState, collectTasksState());
  updateTrayMenu();
}

function resetRunnerIntervalState(runner: DouyinRunner) {
  runner.intervalMode = 'short';
  runner.sameIdsCount = 0;
}

async function clickTextOnPage(win: BrowserWindow, runner: DouyinRunner) {
  const task = runner.task;
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
  } else if (task.showOnClickFailure) {
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

async function runSingleTask(runner: DouyinRunner) {
  const task = runner.task;
  const win = ensureRunnerWindow(runner);
  const capturePromise = createPendingCapture(runner);
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
    await clickTextOnPage(win, runner).catch((error) => {
      if (task.showOnClickFailure && runner.window && !runner.window.isDestroyed()) showDouyinWindowNow(runner.window);
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

function scheduleRunnerTick(runner: DouyinRunner) {
  if (!runner.running) return;
  if (runner.timer) clearTimeout(runner.timer);
  const delayMs = currentRunnerIntervalMs(runner);
  runner.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  runner.timer = setTimeout(() => void runRunnerTick(runner), delayMs);
  sendTasksState();
  logDouyin('monitor next tick scheduled', {
    taskId: runner.taskId,
    mode: runner.intervalMode,
    delayMs,
    sameIdsCount: runner.sameIdsCount,
    retryLimit: runner.task.retryLimit
  });
}

async function runRunnerTick(runner: DouyinRunner) {
  if (!runner.running) return;
  if (runner.tickRunning) {
    logDouyin('monitor tick skipped: already running', { taskId: runner.taskId });
    return;
  }
  runner.tickRunning = true;
  runner.nextRunAt = '';
  sendTasksState();
  logDouyin('monitor tick start', { taskId: runner.taskId });
  try {
    if (!runner.running) return;
    // 单任务执行期间窗口可能被停止/销毁（destroyOnStop），loadURL/executeJavaScript
    // 可能因窗口销毁而 reject；捕获后按「本轮无变化」处理，避免未处理拒绝。
    let result;
    try {
      result = await runSingleTask(runner);
    } catch (error) {
      logDouyin('monitor tick run failed', { taskId: runner.taskId, error: error instanceof Error ? error.message : String(error) });
      result = { captured: false, changed: false, awemeIds: [] };
    }
    if (result.changed) {
      runner.intervalMode = 'short';
      runner.sameIdsCount = 0;
    } else {
      runner.sameIdsCount = Math.min(runner.sameIdsCount + 1, runner.task.retryLimit);
      if (runner.sameIdsCount >= runner.task.retryLimit) runner.intervalMode = 'long';
    }
    logDouyin('monitor tick done', {
      taskId: runner.taskId,
      hasChanged: result.changed,
      mode: runner.intervalMode,
      sameIdsCount: runner.sameIdsCount
    });
  } finally {
    clearPendingCapture(runner);
    runner.tickRunning = false;
    if (runner.running) scheduleRunnerTick(runner);
    else sendTasksState();
  }
}

export function stopRunner(runner: DouyinRunner, opts: { destroyWindow: boolean }) {
  runner.running = false;
  if (runner.timer) clearTimeout(runner.timer);
  runner.timer = undefined;
  runner.nextRunAt = '';
  clearPendingCapture(runner);
  if (opts.destroyWindow) {
    if (runner.window && !runner.window.isDestroyed()) runner.window.destroy();
    runner.window = undefined;
    runner.seenIds = [];
    state.runners.delete(runner.taskId);
  }
  sendTasksState();
  logDouyin('monitor stopped', { taskId: runner.taskId, destroyWindow: opts.destroyWindow });
}

export function startTask(cfg: DouyinTaskConfig) {
  let runner = state.runners.get(cfg.id);
  if (runner) {
    if (runner.timer) clearTimeout(runner.timer);
    runner.timer = undefined;
    clearPendingCapture(runner);
    runner.task = cfg;
    runner.runHidden = cfg.runHidden;
    runner.seenIds = [];
  } else {
    runner = {
      taskId: cfg.id,
      task: cfg,
      intervalMode: 'short',
      sameIdsCount: 0,
      running: false,
      tickRunning: false,
      nextRunAt: '',
      runHidden: cfg.runHidden,
      seenIds: []
    };
    state.runners.set(cfg.id, runner);
  }
  resetRunnerIntervalState(runner);
  runner.running = true;
  runner.nextRunAt = '';
  sendTasksState();
  logDouyin('start task', {
    taskId: cfg.id,
    partition: cfg.partition,
    hidden: cfg.runHidden,
    showOnClickFailure: cfg.showOnClickFailure,
    shortIntervalSeconds: cfg.shortIntervalSeconds,
    longIntervalSeconds: cfg.longIntervalSeconds,
    retryLimit: cfg.retryLimit,
    destroyOnStop: cfg.destroyOnStop
  });
  void runRunnerTick(runner);
}

export function startAll(cfgs: DouyinTaskConfig[]) {
  for (const cfg of cfgs) startTask(cfg);
}

export function stopTask(taskId: string, destroyWindowOverride?: boolean) {
  const runner = state.runners.get(taskId);
  if (!runner) return;
  const destroyWindow = destroyWindowOverride ?? runner.task.destroyOnStop;
  stopRunner(runner, { destroyWindow });
}

export function stopAll(destroyWindowOverride?: boolean) {
  for (const runner of [...state.runners.values()]) {
    const destroyWindow = destroyWindowOverride ?? runner.task.destroyOnStop;
    stopRunner(runner, { destroyWindow });
  }
}

export function refreshTask(taskId: string) {
  const runner = state.runners.get(taskId);
  if (!runner || !runner.running) throw new Error('监听未启动');
  if (runner.timer) clearTimeout(runner.timer);
  runner.timer = undefined;
  runner.nextRunAt = '';
  void runRunnerTick(runner);
}

export function setRunnerHidden(taskId: string, hidden: boolean) {
  const runner = state.runners.get(taskId);
  if (!runner) return;
  runner.runHidden = hidden;
  applyRunnerVisibility(runner);
  sendTasksState();
}
