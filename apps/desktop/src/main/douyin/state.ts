import type { BrowserWindow, Tray } from 'electron';
import type { DouyinRunner } from './types.js';

// 主进程可变状态：不再持有全局监听单例，改为每任务一个 runner。
// - runners：taskId -> 运行时（窗口/定时器/间隔状态机/pending/seenIds）。
// - loginWindows：electron partition 字符串 -> 该 partition 的登录窗口（与监听 runner 解耦）。
// - configuredPartitions：已完成 session 配置（UA/请求头/协议拦截）的 partition 集合。
export const state = {
  mainWindow: undefined as BrowserWindow | undefined,
  tray: undefined as Tray | undefined,
  appQuitting: false,
  runners: new Map<string, DouyinRunner>(),
  loginWindows: new Map<string, BrowserWindow>(),
  configuredPartitions: new Set<string>()
};

export const DOUYIN_TASK_SEEN_IDS_MAX = 200;

// 生命周期内保持同一引用的 WeakSet，用于窗口级监听去重。
export const debugListenerAttached = new WeakSet<BrowserWindow>();
export const debuggerDetachListenerAttached = new WeakSet<BrowserWindow>();
export const devToolsShortcutAttached = new WeakSet<BrowserWindow>();

export function anyRunnerRunning() {
  for (const runner of state.runners.values()) {
    if (runner.running) return true;
  }
  return false;
}

export function findRunnerByWebContents(sender: unknown) {
  for (const runner of state.runners.values()) {
    if (runner.window && !runner.window.isDestroyed() && runner.window.webContents === sender) return runner;
  }
  return undefined;
}

export function isKnownDouyinWebContents(sender: unknown) {
  if (findRunnerByWebContents(sender)) return true;
  for (const win of state.loginWindows.values()) {
    if (win && !win.isDestroyed() && win.webContents === sender) return true;
  }
  return false;
}
