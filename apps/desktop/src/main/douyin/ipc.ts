import { ipcMain } from 'electron';
import { DouyinIpc } from '../../shared/ipc-channels.js';
import type { DouyinTaskConfig } from '../../shared/types.js';
import { logDouyin } from '../log.js';
import { douyinPartition } from './constants.js';
import { handleCapturedCollectsVideoList } from './capture.js';
import {
  collectTasksState,
  refreshTask,
  setRunnerHidden,
  startAll,
  startTask,
  stopAll,
  stopTask
} from './monitor.js';
import { findRunnerByWebContents, isKnownDouyinWebContents } from './state.js';
import { normalizeDouyinTask } from './tasks.js';
import { openLoginWindow } from './window.js';

function normalizePartition(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : douyinPartition;
}

export function registerDouyinIpc() {
  ipcMain.on(DouyinIpc.collectsVideoListCaptured, (event: any, payload: unknown) => {
    const runner = findRunnerByWebContents(event.sender);
    if (!runner) {
      logDouyin('ignored collect list payload from unknown sender');
      return;
    }
    handleCapturedCollectsVideoList(runner, payload);
  });

  ipcMain.on(DouyinIpc.hookLog, (event: any, payload: unknown) => {
    if (!isKnownDouyinWebContents(event.sender)) return;
    logDouyin('page hook log', payload);
  });

  ipcMain.on(DouyinIpc.preloadReady, (event: any, payload: unknown) => {
    if (!isKnownDouyinWebContents(event.sender)) return;
    logDouyin('page preload ready', payload);
  });

  ipcMain.handle(DouyinIpc.openLogin, async (_event: any, partitionInput?: unknown) => {
    const partition = normalizePartition(partitionInput);
    logDouyin('ipc open-login', { partition });
    openLoginWindow(partition);
    logDouyin('open-login done', { partition });
  });

  ipcMain.handle(DouyinIpc.startTask, async (_event: any, taskInput: unknown) => {
    const task = normalizeDouyinTask(taskInput);
    if (!task) throw new Error('任务配置无效');
    startTask(task);
  });

  ipcMain.handle(DouyinIpc.startAll, async (_event: any, tasksInput: unknown) => {
    const tasks = Array.isArray(tasksInput) ? tasksInput.map(normalizeDouyinTask).filter(Boolean) as DouyinTaskConfig[] : [];
    if (tasks.length === 0) throw new Error('请至少配置一个有效任务');
    startAll(tasks);
  });

  ipcMain.handle(DouyinIpc.stopTask, (_event: any, taskId: unknown, destroyWindow?: unknown) => {
    if (typeof taskId !== 'string' || !taskId) return;
    logDouyin('ipc stop-task', { taskId, destroyWindow });
    stopTask(taskId, typeof destroyWindow === 'boolean' ? destroyWindow : undefined);
  });

  ipcMain.handle(DouyinIpc.stopAll, () => {
    logDouyin('ipc stop-all');
    stopAll();
  });

  ipcMain.handle(DouyinIpc.refreshTask, async (_event: any, taskId: unknown) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('监听未启动');
    logDouyin('ipc refresh-task', { taskId });
    refreshTask(taskId);
  });

  ipcMain.handle(DouyinIpc.setTaskHidden, (_event: any, taskId: unknown, hidden?: unknown) => {
    if (typeof taskId !== 'string' || !taskId) return;
    logDouyin('ipc set-task-hidden', { taskId, hidden: Boolean(hidden) });
    setRunnerHidden(taskId, Boolean(hidden));
  });

  ipcMain.handle(DouyinIpc.getTasksState, () => collectTasksState());
}
