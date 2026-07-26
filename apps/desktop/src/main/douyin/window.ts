import { BrowserWindow } from 'electron';
import { DouyinIpc } from '../../shared/ipc-channels.js';
import { normalizeCollectListBaseUrl } from '../../shared/url.js';
import { logDouyin } from '../log.js';
import { isAllowedNavigationUrl, isAllowedWindowOpenUrl } from '../navigation.js';
import { douyinPreloadPath } from '../paths.js';
import { defaultCollectListUrl, douyinUsePageHookCapture } from './constants.js';
import { attachDouyinDebugger } from './debugger.js';
import { stopMonitor } from './monitor.js';
import { configureDouyinSession } from './session.js';
import { state } from './state.js';

export function applyDouyinWindowVisibility(win: BrowserWindow) {
  if (state.douyinRunHidden) {
    win.hide();
    return;
  }
  win.show();
  win.focus();
}

export function currentCollectListEndpoints() {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const task of state.douyinTasks) {
    const next = normalizeCollectListBaseUrl(task.collectListUrl);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    result.push(next);
  }
  if (result.length === 0) result.push(defaultCollectListUrl);
  return result;
}

export function syncDouyinCaptureConfig(win: BrowserWindow) {
  if (!douyinUsePageHookCapture) return;
  const collectListEndpoints = currentCollectListEndpoints();
  win.webContents.send(DouyinIpc.updateCaptureConfig, { collectListEndpoints });
  logDouyin('capture config synced', { collectListEndpoints });
}

export function showDouyinWindowNow(win: BrowserWindow) {
  win.show();
  win.focus();
}

export function ensureDouyinWindow() {
  const douyinSession = configureDouyinSession();
  if (state.douyinWindow && !state.douyinWindow.isDestroyed()) {
    logDouyin('reuse window', { hidden: state.douyinRunHidden });
    applyDouyinWindowVisibility(state.douyinWindow);
    syncDouyinCaptureConfig(state.douyinWindow);
    return state.douyinWindow;
  }
  logDouyin('create window', { hidden: state.douyinRunHidden });
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Douyin',
    show: !state.douyinRunHidden,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      ...(douyinUsePageHookCapture ? { preload: douyinPreloadPath } : {}),
      session: douyinSession
    }
  });
  state.douyinWindow = win;
  applyDouyinWindowVisibility(win);
  win.webContents.setWindowOpenHandler((details: any) => {
    if (isAllowedWindowOpenUrl(details.url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'Douyin',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            backgroundThrottling: false,
            ...(douyinUsePageHookCapture ? { preload: douyinPreloadPath } : {}),
            session: douyinSession
          }
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
    syncDouyinCaptureConfig(win);
    win.webContents
      .executeJavaScript('({ userAgent: navigator.userAgent, platform: navigator.platform, webdriver: navigator.webdriver, userAgentData: navigator.userAgentData })')
      .then((snapshot) => logDouyin('navigator snapshot', snapshot))
      .catch((error) => logDouyin('navigator snapshot failed', error instanceof Error ? error.message : error));
  });
  win.webContents.on('did-fail-load', (_event: any, code: number, description: string, validatedURL: string) => {
    logDouyin('did-fail-load', { code, description, validatedURL });
  });
  win.on('close', (event: any) => {
    if (state.appQuitting || !state.douyinMonitorRunning) return;
    event.preventDefault();
    state.douyinRunHidden = true;
    win.hide();
    logDouyin('window hidden instead of closed while monitoring');
  });
  win.on('minimize', () => {
    if (!state.douyinMonitorRunning) return;
    state.douyinRunHidden = true;
    win.hide();
    logDouyin('window hidden on minimize while monitoring');
  });
  win.on('closed', () => {
    logDouyin('window closed');
    if (state.douyinWindow === win) state.douyinWindow = undefined;
    stopMonitor();
  });
  attachDouyinDebugger(win);
  return win;
}
