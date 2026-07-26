import type { BrowserWindow, Tray } from 'electron';
import type { DouyinTaskConfig } from '../../shared/types.js';
import type { DouyinPendingCapture } from './types.js';

// 主进程可变状态：原先散落在 main.ts 顶部的一组 let 全局变量，收敛为单个对象，
// 以便在拆分后的模块间通过 state.xxx 读写（ESM 无法跨模块重新赋值导出的 let 绑定）。
export const state = {
  mainWindow: undefined as BrowserWindow | undefined,
  douyinWindow: undefined as BrowserWindow | undefined,
  monitorTimer: undefined as NodeJS.Timeout | undefined,
  tray: undefined as Tray | undefined,
  appQuitting: false,
  douyinRunHidden: false,
  douyinShowOnClickFailure: false,
  douyinShortIntervalMs: 10_000,
  douyinLongIntervalMs: 60_000,
  douyinRetryLimit: 3,
  douyinIntervalMode: 'short' as 'short' | 'long',
  douyinSameIdsCount: 0,
  douyinMonitorRunning: false,
  douyinTickRunning: false,
  douyinNextRunAt: '',
  douyinTasks: [] as DouyinTaskConfig[],
  douyinCurrentTaskId: '',
  douyinCurrentTaskLabel: '',
  douyinPendingCapture: undefined as DouyinPendingCapture | undefined
};

// 生命周期内保持同一引用的集合/常量，直接以 const 导出并原地读写。
export const douyinTaskSeenIds = new Map<string, string[]>();
export const DOUYIN_TASK_SEEN_IDS_MAX = 200;
export const debugListenerAttached = new WeakSet<BrowserWindow>();
export const debuggerDetachListenerAttached = new WeakSet<BrowserWindow>();
export const devToolsShortcutAttached = new WeakSet<BrowserWindow>();
