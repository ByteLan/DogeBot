import { BrowserWindow, type Session } from 'electron';
import { DouyinIpc } from '../../shared/ipc-channels.js';
import { normalizeCollectListBaseUrl } from '../../shared/url.js';
import { logDouyin } from '../log.js';
import { isAllowedNavigationUrl, isAllowedWindowOpenUrl } from '../navigation.js';
import { douyinPreloadPath } from '../paths.js';
import { defaultCollectListUrl, douyinUrl, douyinUsePageHookCapture } from './constants.js';
import { attachDouyinDebugger } from './debugger.js';
import { stopRunner } from './monitor.js';
import { configureDouyinSession } from './session.js';
import { state } from './state.js';
import type { DouyinRunner } from './types.js';

const douyinWebPreferences = (ses: Session) => ({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  backgroundThrottling: false,
  ...(douyinUsePageHookCapture ? { preload: douyinPreloadPath } : {}),
  session: ses
});

// 建一个抖音浏览器窗口，装配与原实现一致的通用行为（弹窗拦截、导航守卫、
// 调试器、navigator 快照）。runner / 登录窗口各自再挂自己的生命周期监听。
function buildDouyinWindow(ses: Session, hidden: boolean) {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Douyin',
    show: !hidden,
    webPreferences: douyinWebPreferences(ses)
  });
  win.webContents.setWindowOpenHandler((details: any) => {
    if (isAllowedWindowOpenUrl(details.url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'Douyin',
          webPreferences: douyinWebPreferences(ses)
        }
      };
    }
    logDouyin('blocked deeplink window.open', details.url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event: any, url: string) => {
    if (isAllowedNavigationUrl(url)) return;
    event.preventDefault();
    logDouyin('blocked deeplink will-navigate', url);
  });
  win.webContents.on('will-redirect', (event: any, url: string) => {
    if (isAllowedNavigationUrl(url)) return;
    event.preventDefault();
    logDouyin('blocked deeplink will-redirect', url);
  });
  (win.webContents as any).on('will-frame-navigate', (event: any, url: string, isMainFrame: boolean, frameProcessId: number, frameRoutingId: number) => {
    if (isAllowedNavigationUrl(url)) return;
    event.preventDefault();
    logDouyin('blocked deeplink will-frame-navigate', { url, isMainFrame, frameProcessId, frameRoutingId });
  });
  win.webContents.on('did-start-loading', () => logDouyin('did-start-loading', win.webContents.getURL()));
  win.webContents.on('did-finish-load', () => {
    logDouyin('did-finish-load', win.webContents.getURL());
    win.webContents
      .executeJavaScript('({ userAgent: navigator.userAgent, platform: navigator.platform, webdriver: navigator.webdriver, userAgentData: navigator.userAgentData })')
      .then((snapshot) => logDouyin('navigator snapshot', snapshot))
      .catch((error) => logDouyin('navigator snapshot failed', error instanceof Error ? error.message : error));
  });
  win.webContents.on('did-fail-load', (_event: any, code: number, description: string, validatedURL: string) => {
    logDouyin('did-fail-load', { code, description, validatedURL });
  });
  attachDouyinDebugger(win);
  return win;
}

export function applyRunnerVisibility(runner: DouyinRunner) {
  const win = runner.window;
  if (!win || win.isDestroyed()) return;
  if (runner.runHidden) {
    win.hide();
    return;
  }
  win.show();
  win.focus();
}

export function showDouyinWindowNow(win: BrowserWindow) {
  win.show();
  win.focus();
}

// 仅同步该 runner 任务自己的 collectList 端点：每窗口页内的
// __dogebotDouyinCollectListEndpoints 覆盖优先，共享 partition 下也互不干扰。
export function syncRunnerCaptureConfig(runner: DouyinRunner) {
  if (!douyinUsePageHookCapture) return;
  const win = runner.window;
  if (!win || win.isDestroyed()) return;
  const base = normalizeCollectListBaseUrl(runner.task.collectListUrl);
  const collectListEndpoints = base ? [base] : [defaultCollectListUrl];
  win.webContents.send(DouyinIpc.updateCaptureConfig, { collectListEndpoints });
  logDouyin('capture config synced', { taskId: runner.taskId, collectListEndpoints });
}

export function ensureRunnerWindow(runner: DouyinRunner) {
  const ses = configureDouyinSession(runner.task.partition);
  if (runner.window && !runner.window.isDestroyed()) {
    logDouyin('reuse window', { taskId: runner.taskId, hidden: runner.runHidden });
    applyRunnerVisibility(runner);
    syncRunnerCaptureConfig(runner);
    return runner.window;
  }
  logDouyin('create window', { taskId: runner.taskId, hidden: runner.runHidden, partition: runner.task.partition });
  const win = buildDouyinWindow(ses, runner.runHidden);
  runner.window = win;
  applyRunnerVisibility(runner);
  win.webContents.on('did-finish-load', () => syncRunnerCaptureConfig(runner));
  win.on('close', (event: any) => {
    if (state.appQuitting || !runner.running) return;
    event.preventDefault();
    runner.runHidden = true;
    win.hide();
    logDouyin('window hidden instead of closed while monitoring', { taskId: runner.taskId });
  });
  win.on('minimize', () => {
    if (!runner.running) return;
    runner.runHidden = true;
    win.hide();
    logDouyin('window hidden on minimize while monitoring', { taskId: runner.taskId });
  });
  win.on('closed', () => {
    logDouyin('window closed', { taskId: runner.taskId });
    if (runner.window === win) runner.window = undefined;
    stopRunner(runner, { destroyWindow: false });
  });
  return win;
}

// 登录窗口：按 partition 建/复用，加载 douyin 首页供扫码登录（与监听 runner 解耦）。
export function openLoginWindow(partition: string) {
  const ses = configureDouyinSession(partition);
  const existing = state.loginWindows.get(partition);
  if (existing && !existing.isDestroyed()) {
    showDouyinWindowNow(existing);
    void existing.loadURL(douyinUrl);
    return existing;
  }
  const win = buildDouyinWindow(ses, false);
  state.loginWindows.set(partition, win);
  win.on('closed', () => {
    if (state.loginWindows.get(partition) === win) state.loginWindows.delete(partition);
    logDouyin('login window closed', { partition });
  });
  void win.loadURL(douyinUrl);
  showDouyinWindowNow(win);
  return win;
}
