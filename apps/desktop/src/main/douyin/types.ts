import type { BrowserWindow } from 'electron';
import type { DouyinTaskConfig } from '../../shared/types.js';

export type DouyinCollectCaptureMode = 'page-hook' | 'fetch-debugger';

export type DouyinTaskRunResult = {
  captured: boolean;
  changed: boolean;
  awemeIds: string[];
};

export type DouyinPendingCapture = {
  task: DouyinTaskConfig;
  resolve: (result: DouyinTaskRunResult) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
};

// 每个任务的独立运行时：自持窗口、定时器、间隔状态机、pending、显隐、seenIds。
export type DouyinRunner = {
  taskId: string;
  task: DouyinTaskConfig;
  window?: BrowserWindow;
  timer?: NodeJS.Timeout;
  intervalMode: 'short' | 'long';
  sameIdsCount: number;
  running: boolean;
  tickRunning: boolean;
  nextRunAt: string;
  runHidden: boolean;
  pendingCapture?: DouyinPendingCapture;
  seenIds: string[];
};
