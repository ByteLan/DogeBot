import { app, BrowserWindow, ipcMain, session } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const douyinUrl = 'https://www.douyin.com';
const favoriteUrl = 'https://www.douyin.com/user/self?from_tab_name=main&showSubTab=favorite_folder&showTab=favorite_collection';
const collectListUrl = 'https://www.douyin.com/aweme/v1/web/collects/video/list/';
const douyinPartition = 'persist:dogebot-douyin';
const chromeVersion = process.versions.chrome;
const douyinUserAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
const blockedDeeplinkSchemes = ['bitbrowser'];
const douyinUaMetadata = {
  brands: [
    { brand: 'Chromium', version: chromeVersion.split('.')[0] },
    { brand: 'Google Chrome', version: chromeVersion.split('.')[0] },
    { brand: 'Not.A/Brand', version: '99' }
  ],
  mobile: false,
  platform: 'macOS'
};

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('lang', 'zh-CN');

let mainWindow: BrowserWindow | undefined;
let douyinWindow: BrowserWindow | undefined;
let monitorTimer: NodeJS.Timeout | undefined;
let clickText = '';
let douyinRunHidden = false;
let douyinShowOnClickFailure = false;
let douyinSkipClick = false;
let douyinCollectsId = '';
let douyinShortIntervalMs = 10_000;
let douyinLongIntervalMs = 60_000;
let douyinRetryLimit = 3;
let douyinIntervalMode: 'short' | 'long' = 'short';
let douyinSameIdsCount = 0;
let douyinLastIdsKey = '';
let douyinMonitorRunning = false;
const pendingResponses = new Map<string, { url: string; status: number }>();
const debugListenerAttached = new WeakSet<BrowserWindow>();
const devToolsShortcutAttached = new WeakSet<BrowserWindow>();
let douyinSessionConfigured = false;

function logDouyin(message: string, data?: unknown) {
  if (data === undefined) {
    console.log(`[douyin] ${message}`);
    return;
  }
  console.log(`[douyin] ${message}`, data);
}

function installDevToolsShortcut(win: BrowserWindow) {
  if (devToolsShortcutAttached.has(win)) return;
  devToolsShortcutAttached.add(win);
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F12') return;
    event.preventDefault();
    if (win.webContents.isDevToolsOpened()) {
      win.webContents.closeDevTools();
      return;
    }
    win.webContents.openDevTools({ mode: 'detach' });
  });
}

function isAllowedNavigationUrl(url: string) {
  if (!url) return false;
  if (url.startsWith('about:')) return true;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'ws:', 'wss:', 'blob:', 'data:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isAllowedWindowOpenUrl(url: string) {
  if (!url) return false;
  if (url.startsWith('about:')) return true;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isBlockedDeeplinkUrl(url: string) {
  try {
    return blockedDeeplinkSchemes.includes(new URL(url).protocol.replace(/:$/, ''));
  } catch {
    return false;
  }
}

function isCollectListUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}` === collectListUrl && parsed.searchParams.getAll('collects_id').includes(douyinCollectsId);
  } catch {
    return false;
  }
}

function applyDouyinWindowVisibility(win: BrowserWindow) {
  if (douyinRunHidden) {
    win.hide();
    return;
  }
  win.show();
  win.focus();
}

function showDouyinWindowNow(win: BrowserWindow) {
  win.show();
  win.focus();
}

function toPositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function currentMonitorIntervalMs() {
  return douyinIntervalMode === 'long' ? douyinLongIntervalMs : douyinShortIntervalMs;
}

function resetMonitorIntervalState() {
  douyinIntervalMode = 'short';
  douyinSameIdsCount = 0;
  douyinLastIdsKey = '';
}

function registerBlockedDeeplinkHandlers() {
  if (process.defaultApp) {
    logDouyin('skip deeplink handler registration in dev mode', {
      executable: process.execPath,
      args: process.argv.slice(1)
    });
    return;
  }
  for (const scheme of blockedDeeplinkSchemes) {
    const removedDefault = app.removeAsDefaultProtocolClient(scheme);
    const registered = app.setAsDefaultProtocolClient(scheme);
    logDouyin('deeplink handler registration', {
      scheme,
      removedDefault,
      registered,
      isDefault: app.isDefaultProtocolClient(scheme)
    });
  }
}

function configureDouyinSession() {
  const ses = session.fromPartition(douyinPartition);
  if (douyinSessionConfigured) return ses;
  douyinSessionConfigured = true;
  ses.setUserAgent(douyinUserAgent);
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://www.douyin.com/*', '*://*.douyin.com/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    headers['User-Agent'] = douyinUserAgent;
    headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
    headers['sec-ch-ua'] = '"Chromium";v="' + chromeVersion.split('.')[0] + '", "Google Chrome";v="' + chromeVersion.split('.')[0] + '", "Not.A/Brand";v="99"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"macOS"';
    delete headers['user-agent'];
    delete headers['accept-language'];
    delete headers['Sec-Ch-Ua'];
    delete headers['Sec-Ch-Ua-Mobile'];
    delete headers['Sec-Ch-Ua-Platform'];
    callback({ requestHeaders: headers });
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowedNavigationUrl(details.url)) {
      callback({});
      return;
    }
    logDouyin('blocked custom protocol request', { url: details.url, resourceType: details.resourceType });
    callback({ cancel: true });
  });
  logDouyin('session configured', { userAgent: douyinUserAgent, partition: douyinPartition });
  return ses;
}

app.on('open-url', (event, url) => {
  if (!isBlockedDeeplinkUrl(url)) return;
  event.preventDefault();
  logDouyin('swallowed registered deeplink', url);
});

app.on('browser-window-created', (_event, win) => {
  installDevToolsShortcut(win);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    title: 'DogeBot',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs')
    }
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  win.loadFile(join(__dirname, 'index.html'));
}

function ensureDouyinWindow() {
  const douyinSession = configureDouyinSession();
  if (douyinWindow && !douyinWindow.isDestroyed()) {
    logDouyin('reuse window', { hidden: douyinRunHidden });
    applyDouyinWindowVisibility(douyinWindow);
    return douyinWindow;
  }
  logDouyin('create window', { hidden: douyinRunHidden });
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Douyin',
    show: !douyinRunHidden,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      session: douyinSession
    }
  });
  douyinWindow = win;
  applyDouyinWindowVisibility(win);
  win.webContents.setWindowOpenHandler((details) => {
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
            session: douyinSession
          }
        }
      };
    }
    logDouyin('blocked deeplink window.open', details.url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigationUrl(url)) return;
    event.preventDefault();
    logDouyin('blocked deeplink will-navigate', url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (isAllowedNavigationUrl(url)) return;
    event.preventDefault();
    logDouyin('blocked deeplink will-redirect', url);
  });
  (win.webContents as any).on('will-frame-navigate', (event: Electron.Event, url: string, isMainFrame: boolean, frameProcessId: number, frameRoutingId: number) => {
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
  win.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
    logDouyin('did-fail-load', { code, description, validatedURL });
  });
  win.on('closed', () => {
    logDouyin('window closed');
    if (douyinWindow === win) douyinWindow = undefined;
    stopMonitor();
  });
  attachDouyinDebugger(win);
  return win;
}

function attachDouyinDebugger(win: BrowserWindow) {
  if (debugListenerAttached.has(win)) return;
  const { debugger: devtools } = win.webContents;
  if (!devtools.isAttached()) {
    try {
      devtools.attach('1.3');
      devtools.sendCommand('Network.enable').catch(() => undefined);
      devtools
        .sendCommand('Emulation.setUserAgentOverride', {
          userAgent: douyinUserAgent,
          platform: 'macOS',
          userAgentMetadata: douyinUaMetadata
        })
        .catch((error) => logDouyin('user agent override failed', error instanceof Error ? error.message : error));
      devtools
        .sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: `
            (() => {
              const userAgent = ${JSON.stringify(douyinUserAgent)};
              const uaMetadata = ${JSON.stringify(douyinUaMetadata)};
              const isAllowedWebUrl = (url) => {
                if (!url) return true;
                if (String(url).startsWith('about:')) return true;
                try {
                  return ['http:', 'https:', 'ws:', 'wss:', 'blob:', 'data:'].includes(new URL(String(url), location.href).protocol);
                } catch {
                  return false;
                }
              };
              const blockDeeplink = (url, source) => {
                if (isAllowedWebUrl(url)) return false;
                console.warn('[douyin injected] blocked deeplink', source, url);
                return true;
              };
              const define = (target, key, value) => {
                try {
                  Object.defineProperty(target, key, { get: () => value, configurable: true });
                } catch {}
              };
              define(Navigator.prototype, 'userAgent', userAgent);
              define(Navigator.prototype, 'appVersion', userAgent.replace(/^Mozilla\\//, ''));
              define(Navigator.prototype, 'platform', 'MacIntel');
              define(Navigator.prototype, 'webdriver', undefined);
              define(Navigator.prototype, 'userAgentData', {
                brands: uaMetadata.brands,
                mobile: uaMetadata.mobile,
                platform: uaMetadata.platform,
                getHighEntropyValues: async (hints) => {
                  const values = {
                    brands: uaMetadata.brands,
                    mobile: uaMetadata.mobile,
                    platform: uaMetadata.platform,
                    architecture: 'arm',
                    bitness: '64',
                    model: '',
                    platformVersion: '14.0.0',
                    fullVersionList: uaMetadata.brands.map((brand) => ({ brand: brand.brand, version: ${JSON.stringify(chromeVersion)} })),
                    uaFullVersion: ${JSON.stringify(chromeVersion)}
                  };
                  return Object.fromEntries((hints || []).filter((hint) => hint in values).map((hint) => [hint, values[hint]]));
                }
              });
              window.chrome = window.chrome || { runtime: {} };
              const originalOpen = window.open;
              window.open = function(url, ...args) {
                if (blockDeeplink(url, 'window.open')) return null;
                return originalOpen.call(window, url, ...args);
              };
              const originalAssign = Location.prototype.assign;
              Location.prototype.assign = function(url) {
                if (blockDeeplink(url, 'location.assign')) return;
                return originalAssign.call(this, url);
              };
              const originalReplace = Location.prototype.replace;
              Location.prototype.replace = function(url) {
                if (blockDeeplink(url, 'location.replace')) return;
                return originalReplace.call(this, url);
              };
              document.addEventListener('click', (event) => {
                const target = event.target && event.target.closest ? event.target.closest('a[href]') : null;
                if (target && blockDeeplink(target.href, 'anchor.click')) {
                  event.preventDefault();
                  event.stopImmediatePropagation();
                }
              }, true);
              document.addEventListener('submit', (event) => {
                const target = event.target;
                const action = target && target.getAttribute ? target.getAttribute('action') : '';
                if (action && blockDeeplink(action, 'form.submit')) {
                  event.preventDefault();
                  event.stopImmediatePropagation();
                }
              }, true);
              const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                  for (const node of mutation.addedNodes) {
                    if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
                    const elements = node.matches && node.matches('[src],[href]') ? [node] : Array.from(node.querySelectorAll ? node.querySelectorAll('[src],[href]') : []);
                    for (const element of elements) {
                      const value = element.getAttribute('src') || element.getAttribute('href');
                      if (value && blockDeeplink(value, element.tagName.toLowerCase())) element.remove();
                    }
                  }
                }
              });
              observer.observe(document.documentElement, { childList: true, subtree: true });
            })();
          `
        })
        .catch((error) => logDouyin('navigator override failed', error instanceof Error ? error.message : error));
      logDouyin('debugger attached');
    } catch {
      logDouyin('debugger attach failed');
      return;
    }
  }
  debugListenerAttached.add(win);
  devtools.on('message', (_event, method, params) => {
    if (method === 'Network.responseReceived' && typeof params?.response?.url === 'string') {
      const url = params.response.url as string;
      if (isCollectListUrl(url)) {
        logDouyin('matched response', { requestId: params.requestId, status: params.response.status, url });
        pendingResponses.set(params.requestId, { url, status: params.response.status });
      }
    }
    if (method === 'Network.loadingFinished' && pendingResponses.has(params.requestId)) {
      const meta = pendingResponses.get(params.requestId);
      pendingResponses.delete(params.requestId);
      devtools
        .sendCommand('Network.getResponseBody', { requestId: params.requestId })
        .then((result) => {
          logDouyin('response body captured', { requestId: params.requestId, length: result.body.length });
          mainWindow?.webContents.send('douyin:collects-video-list', {
            url: meta?.url,
            status: meta?.status,
            body: result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body,
            receivedAt: new Date().toISOString()
          });
        })
        .catch((error) => {
          logDouyin('response body failed', error instanceof Error ? error.message : error);
          mainWindow?.webContents.send('douyin:collects-video-list', {
            url: meta?.url,
            status: meta?.status,
            error: error instanceof Error ? error.message : '读取响应失败',
            receivedAt: new Date().toISOString()
          });
        });
    }
  });
}

async function clickTextOnPage(win: BrowserWindow) {
  if (!clickText.trim()) {
    logDouyin('skip click: empty text');
    return;
  }
  logDouyin('click text on page', clickText.trim());
  const result = await win.webContents.executeJavaScript(
    `
      (() => {
        const keyword = ${JSON.stringify(clickText.trim())};
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
  } else if (douyinShowOnClickFailure) {
    showDouyinWindowNow(win);
  }
  logDouyin('click result', result);
  mainWindow?.webContents.send('douyin:click-result', { ...result, clickedAt: new Date().toISOString() });
}

function scheduleMonitorTick() {
  if (!douyinMonitorRunning) return;
  if (monitorTimer) clearTimeout(monitorTimer);
  const delayMs = currentMonitorIntervalMs();
  monitorTimer = setTimeout(() => void runMonitorTick(), delayMs);
  logDouyin('monitor next tick scheduled', {
    mode: douyinIntervalMode,
    delayMs,
    sameIdsCount: douyinSameIdsCount,
    retryLimit: douyinRetryLimit
  });
}

async function runMonitorTick() {
  if (!douyinMonitorRunning) return;
  logDouyin('monitor tick start', { clickText, skipClick: douyinSkipClick });
  const win = ensureDouyinWindow();
  await win.loadURL(favoriteUrl, { userAgent: douyinUserAgent });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (douyinSkipClick) {
    mainWindow?.webContents.send('douyin:click-result', {
      clicked: true,
      text: clickText,
      skipped: true,
      clickedAt: new Date().toISOString()
    });
    scheduleMonitorTick();
    return;
  }
  await clickTextOnPage(win).catch((error) => {
    if (douyinShowOnClickFailure) showDouyinWindowNow(win);
    mainWindow?.webContents.send('douyin:click-result', {
      clicked: false,
      reason: error instanceof Error ? error.message : '模拟点击失败',
      clickedAt: new Date().toISOString()
    });
  });
  scheduleMonitorTick();
}

function stopMonitor() {
  douyinMonitorRunning = false;
  if (monitorTimer) clearTimeout(monitorTimer);
  monitorTimer = undefined;
  logDouyin('monitor stopped');
}

ipcMain.handle('douyin:open-login', async () => {
  logDouyin('ipc open-login');
  douyinRunHidden = false;
  const win = ensureDouyinWindow();
  logDouyin('load douyin login url', douyinUrl);
  await win.loadURL(douyinUrl, { userAgent: douyinUserAgent });
  applyDouyinWindowVisibility(win);
  logDouyin('open-login done');
});

ipcMain.handle('douyin:start-monitor', async (
  _event,
  text: string,
  hidden?: boolean,
  showOnClickFailure?: boolean,
  collectsId?: string,
  skipClick?: boolean,
  shortIntervalSeconds?: number,
  longIntervalSeconds?: number,
  retryLimit?: number
) => {
  douyinRunHidden = Boolean(hidden);
  douyinShowOnClickFailure = Boolean(showOnClickFailure);
  douyinSkipClick = Boolean(skipClick);
  douyinCollectsId = String(collectsId || '').trim();
  douyinShortIntervalMs = toPositiveInteger(shortIntervalSeconds, 10) * 1000;
  douyinLongIntervalMs = toPositiveInteger(longIntervalSeconds, 60) * 1000;
  douyinRetryLimit = toPositiveInteger(retryLimit, 3);
  resetMonitorIntervalState();
  douyinMonitorRunning = true;
  logDouyin('ipc start-monitor', {
    text,
    hidden: douyinRunHidden,
    showOnClickFailure: douyinShowOnClickFailure,
    collectsId: douyinCollectsId,
    skipClick: douyinSkipClick,
    shortIntervalMs: douyinShortIntervalMs,
    longIntervalMs: douyinLongIntervalMs,
    retryLimit: douyinRetryLimit
  });
  clickText = text;
  if (monitorTimer) clearTimeout(monitorTimer);
  monitorTimer = undefined;
  await runMonitorTick();
});

ipcMain.handle('douyin:report-aweme-ids', (_event, ids?: unknown[]) => {
  if (!douyinMonitorRunning) return;
  const awemeIds = Array.isArray(ids) ? ids.map((id) => String(id || '').trim()).filter(Boolean) : [];
  const idsKey = JSON.stringify(awemeIds);
  if (awemeIds.length === 0) {
    if (douyinIntervalMode === 'long') {
      resetMonitorIntervalState();
      scheduleMonitorTick();
    }
    logDouyin('aweme ids empty', { mode: douyinIntervalMode, sameIdsCount: douyinSameIdsCount });
    return;
  }
  if (!douyinLastIdsKey || idsKey !== douyinLastIdsKey) {
    douyinLastIdsKey = idsKey;
    douyinSameIdsCount = 0;
    douyinIntervalMode = 'short';
    scheduleMonitorTick();
    logDouyin('aweme ids changed, switch short interval', { count: awemeIds.length });
    return;
  }
  if (douyinIntervalMode === 'short') {
    douyinSameIdsCount += 1;
    if (douyinSameIdsCount >= douyinRetryLimit) {
      douyinIntervalMode = 'long';
      scheduleMonitorTick();
    }
  }
  logDouyin('aweme ids same', {
    mode: douyinIntervalMode,
    count: awemeIds.length,
    sameIdsCount: douyinSameIdsCount,
    retryLimit: douyinRetryLimit
  });
});

ipcMain.handle('douyin:set-hidden', (_event, hidden?: boolean) => {
  douyinRunHidden = Boolean(hidden);
  logDouyin('ipc set-hidden', { hidden: douyinRunHidden });
  if (douyinWindow && !douyinWindow.isDestroyed()) applyDouyinWindowVisibility(douyinWindow);
});

ipcMain.handle('douyin:stop-monitor', () => {
  logDouyin('ipc stop-monitor');
  stopMonitor();
});

app.whenReady().then(() => {
  registerBlockedDeeplinkHandlers();
  createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
