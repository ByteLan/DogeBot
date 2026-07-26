import { ipcMain } from 'electron';
import { DouyinIpc } from '../../shared/ipc-channels.js';
import type { DouyinMonitorSharedConfig, DouyinTaskConfig } from '../../shared/types.js';
import { logDouyin } from '../log.js';
import { douyinUrl, douyinUserAgent } from './constants.js';
import { handleCapturedCollectsVideoList } from './capture.js';
import {
  currentMonitorState,
  resetMonitorIntervalState,
  runMonitorTick,
  sendMonitorState,
  stopMonitor
} from './monitor.js';
import { douyinTaskSeenIds, state } from './state.js';
import { normalizeDouyinTask, toPositiveInteger } from './tasks.js';
import { applyDouyinWindowVisibility, ensureDouyinWindow, syncDouyinCaptureConfig } from './window.js';

export function registerDouyinIpc() {
  ipcMain.on(DouyinIpc.collectsVideoListCaptured, (event: any, payload: unknown) => {
    if (!state.douyinWindow || event.sender !== state.douyinWindow.webContents) {
      logDouyin('ignored collect list payload from unknown sender');
      return;
    }
    handleCapturedCollectsVideoList(payload);
  });

  ipcMain.on(DouyinIpc.hookLog, (event: any, payload: unknown) => {
    if (!state.douyinWindow || event.sender !== state.douyinWindow.webContents) return;
    logDouyin('page hook log', payload);
  });

  ipcMain.on(DouyinIpc.preloadReady, (event: any, payload: unknown) => {
    if (!state.douyinWindow || event.sender !== state.douyinWindow.webContents) return;
    logDouyin('page preload ready', payload);
  });

  ipcMain.handle(DouyinIpc.openLogin, async () => {
    logDouyin('ipc open-login');
    state.douyinRunHidden = false;
    const win = ensureDouyinWindow();
    logDouyin('load douyin login url', douyinUrl);
    await win.loadURL(douyinUrl, { userAgent: douyinUserAgent });
    applyDouyinWindowVisibility(win);
    logDouyin('open-login done');
  });

  ipcMain.handle(DouyinIpc.startMonitor, async (_event: any, tasksInput: unknown, sharedConfigInput?: DouyinMonitorSharedConfig) => {
    const tasks = Array.isArray(tasksInput) ? tasksInput.map(normalizeDouyinTask).filter(Boolean) as DouyinTaskConfig[] : [];
    if (tasks.length === 0) throw new Error('请至少配置一个有效任务');
    state.douyinRunHidden = Boolean(sharedConfigInput?.hidden);
    state.douyinShowOnClickFailure = Boolean(sharedConfigInput?.showOnClickFailure);
    state.douyinShortIntervalMs = toPositiveInteger(sharedConfigInput?.shortIntervalSeconds, 10) * 1000;
    state.douyinLongIntervalMs = toPositiveInteger(sharedConfigInput?.longIntervalSeconds, 60) * 1000;
    state.douyinRetryLimit = toPositiveInteger(sharedConfigInput?.retryLimit, 3);
    state.douyinTasks = tasks;
    douyinTaskSeenIds.clear();
    if (state.douyinWindow && !state.douyinWindow.isDestroyed()) syncDouyinCaptureConfig(state.douyinWindow);
    resetMonitorIntervalState();
    state.douyinMonitorRunning = true;
    state.douyinNextRunAt = '';
    sendMonitorState();
    logDouyin('ipc start-monitor', {
      hidden: state.douyinRunHidden,
      showOnClickFailure: state.douyinShowOnClickFailure,
      shortIntervalMs: state.douyinShortIntervalMs,
      longIntervalMs: state.douyinLongIntervalMs,
      retryLimit: state.douyinRetryLimit,
      tasks: state.douyinTasks.map((task) => ({
        id: task.id,
        favoriteUrl: task.favoriteUrl,
        collectListUrl: task.collectListUrl,
        requestUrlFilter: task.requestUrlFilter,
        clickText: task.clickText,
        skipClick: task.skipClick
      }))
    });
    if (state.monitorTimer) clearTimeout(state.monitorTimer);
    state.monitorTimer = undefined;
    await runMonitorTick();
  });

  ipcMain.handle(DouyinIpc.setHidden, (_event: any, hidden?: boolean) => {
    state.douyinRunHidden = Boolean(hidden);
    logDouyin('ipc set-hidden', { hidden: state.douyinRunHidden });
    if (state.douyinWindow && !state.douyinWindow.isDestroyed()) applyDouyinWindowVisibility(state.douyinWindow);
  });

  ipcMain.handle(DouyinIpc.stopMonitor, () => {
    logDouyin('ipc stop-monitor');
    stopMonitor();
  });

  ipcMain.handle(DouyinIpc.refreshNow, async () => {
    logDouyin('ipc refresh-now');
    if (!state.douyinMonitorRunning) throw new Error('监听未启动');
    if (state.monitorTimer) clearTimeout(state.monitorTimer);
    state.monitorTimer = undefined;
    state.douyinNextRunAt = '';
    await runMonitorTick();
  });

  ipcMain.handle(DouyinIpc.getMonitorState, () => currentMonitorState());
}
