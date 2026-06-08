import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, session } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const douyinUrl = 'https://www.douyin.com';
const favoriteUrl = 'https://www.douyin.com/user/self?from_tab_name=main&showSubTab=favorite_folder&showTab=favorite_collection';
const collectListUrl = 'https://www.douyin.com/aweme/v1/web/collects/video/list/';
type DouyinCollectCaptureMode = 'page-hook' | 'fetch-debugger';
const douyinCollectCaptureMode = 'page-hook' as DouyinCollectCaptureMode;
const douyinUsePageHookCapture = douyinCollectCaptureMode === 'page-hook';
const douyinUseFetchDebuggerCapture = douyinCollectCaptureMode === 'fetch-debugger';
const douyinUseCdpPageHookCapture = false;
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
let tray: Tray | undefined;
let appQuitting = false;
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
let douyinTickRunning = false;
let douyinNextRunAt = '';
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

function currentMonitorState() {
  return {
    running: douyinMonitorRunning,
    mode: douyinIntervalMode,
    currentIntervalSeconds: Math.round(currentMonitorIntervalMs() / 1000),
    shortIntervalSeconds: Math.round(douyinShortIntervalMs / 1000),
    longIntervalSeconds: Math.round(douyinLongIntervalMs / 1000),
    sameIdsCount: douyinSameIdsCount,
    retryLimit: douyinRetryLimit,
    nextRunAt: douyinNextRunAt,
    tickRunning: douyinTickRunning
  };
}

function sendMonitorState() {
  mainWindow?.webContents.send('douyin:monitor-state', currentMonitorState());
  updateTrayMenu();
}

function buildTrayIcon() {
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="8" fill="#111827"/>
      <text x="16" y="22" text-anchor="middle" font-family="Arial" font-size="18" font-weight="700" fill="#ffffff">D</text>
    </svg>
  `);
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  sendMonitorState();
}

function hideMainWindowToTray() {
  mainWindow?.hide();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 DogeBot', click: showMainWindow },
    {
      label: '停止监听',
      click: () => stopMonitor(),
      enabled: douyinMonitorRunning
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        appQuitting = true;
        app.quit();
      }
    }
  ]));
}

function createTray() {
  if (tray) return;
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('DogeBot');
  updateTrayMenu();
  tray.on('click', showMainWindow);
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
  win.on('close', (event) => {
    if (appQuitting) return;
    event.preventDefault();
    hideMainWindowToTray();
  });
  win.on('minimize', () => {
    hideMainWindowToTray();
  });
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
      ...(douyinUsePageHookCapture ? { preload: join(__dirname, 'douyin-preload.cjs') } : {}),
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
            ...(douyinUsePageHookCapture ? { preload: join(__dirname, 'douyin-preload.cjs') } : {}),
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
  win.on('close', (event) => {
    if (appQuitting || !douyinMonitorRunning) return;
    event.preventDefault();
    douyinRunHidden = true;
    win.hide();
    logDouyin('window hidden instead of closed while monitoring');
  });
  win.on('minimize', () => {
    if (!douyinMonitorRunning) return;
    douyinRunHidden = true;
    win.hide();
    logDouyin('window hidden on minimize while monitoring');
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
      devtools.on('detach', (_event, reason) => {
        logDouyin('debugger detached', reason);
        debugListenerAttached.delete(win);
        setTimeout(() => attachDouyinDebugger(win), 1000);
      });
      if (douyinUseFetchDebuggerCapture) {
        devtools.sendCommand('Network.enable', {
          maxResourceBufferSize: 1024 * 1024 * 50,
          maxTotalBufferSize: 1024 * 1024 * 100
        }).catch(() => undefined);
        devtools.sendCommand('Fetch.enable', {
          patterns: [{ requestStage: 'Response' }]
        }).catch((error) => logDouyin('Fetch.enable failed', error));
      }
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
              if (window.__dogebotDouyinHookInstalled) return;
              window.__dogebotDouyinHookInstalled = true;
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
              if (${JSON.stringify(douyinUseCdpPageHookCapture)}) {
              const collectListEndpoint = ${JSON.stringify(collectListUrl)};
              const isCollectListApiUrl = (url) => {
                if (!url) return false;
                try {
                  const parsed = new URL(String(url), location.href);
                  return parsed.origin + parsed.pathname === collectListEndpoint;
                } catch {
                  return false;
                }
              };
              const hookLog = (message, data) => {
                try {
                  window.dispatchEvent(new CustomEvent('dogebot-douyin-hook-event', {
                    detail: JSON.stringify({
                      source: 'dogebot-douyin-hook',
                      type: 'hook-log',
                      payload: { message, data }
                    })
                  }));
                } catch {}
                if (window.__dogebotDouyinCapture && typeof window.__dogebotDouyinCapture.log === 'function') {
                  try {
                    window.__dogebotDouyinCapture.log(message, data);
                  } catch {}
                }
              };
              const emitCollectList = (payload) => {
                const message = {
                  ...payload,
                  receivedAt: new Date().toISOString()
                };
                if (window.__dogebotDouyinCapture && typeof window.__dogebotDouyinCapture.sendCollectsVideoList === 'function') {
                  try {
                    window.__dogebotDouyinCapture.sendCollectsVideoList(message);
                    return;
                  } catch (error) {
                    console.warn('[douyin injected] bridge collect list failed', error);
                  }
                }
                try {
                  window.dispatchEvent(new CustomEvent('dogebot-douyin-hook-event', {
                    detail: JSON.stringify({
                      source: 'dogebot-douyin-hook',
                      type: 'collects-video-list',
                      payload: message
                    })
                  }));
                  return;
                } catch (error) {
                  console.warn('[douyin injected] event collect list failed', error);
                }
                try {
                  window.postMessage({
                    source: 'dogebot-douyin-hook',
                    type: 'collects-video-list',
                    payload: message
                  }, '*');
                } catch (error) {
                  console.warn('[douyin injected] emit collect list failed', error);
                }
              };
              hookLog('installed', { href: location.href, hasBridge: Boolean(window.__dogebotDouyinCapture) });
              const readBlobText = (blob) => blob && typeof blob.text === 'function' ? blob.text() : Promise.resolve('');
              const decodeArrayBuffer = (buffer) => {
                try {
                  return new TextDecoder('utf-8').decode(buffer);
                } catch {
                  return '';
                }
              };
              const originalFetch = window.fetch;
              if (typeof originalFetch === 'function') {
                window.fetch = async function(input, init) {
                  const response = await originalFetch.apply(this, arguments);
                  const requestUrl = typeof input === 'string'
                    ? input
                    : input && typeof Request !== 'undefined' && input instanceof Request
                      ? input.url
                      : String(input || '');
                  const responseUrl = response && response.url ? response.url : requestUrl;
                  if (isCollectListApiUrl(responseUrl) || isCollectListApiUrl(requestUrl)) {
                    hookLog('fetch matched', { requestUrl, responseUrl, status: response.status });
                    response.clone().text()
                      .then((body) => emitCollectList({
                        source: 'fetch',
                        url: responseUrl || requestUrl,
                        status: response.status,
                        body
                      }))
                      .catch((error) => emitCollectList({
                        source: 'fetch',
                        url: responseUrl || requestUrl,
                        status: response.status,
                        error: error instanceof Error ? error.message : '读取 fetch 响应失败'
                      }));
                  }
                  return response;
                };
                try {
                  Object.defineProperty(window.fetch, 'toString', { value: () => originalFetch.toString(), configurable: true });
                } catch {}
              }
              const originalXhrOpen = XMLHttpRequest.prototype.open;
              const originalXhrSend = XMLHttpRequest.prototype.send;
              XMLHttpRequest.prototype.open = function(method, url) {
                this.__dogebotMethod = method;
                this.__dogebotUrl = url;
                return originalXhrOpen.apply(this, arguments);
              };
              XMLHttpRequest.prototype.send = function() {
                const xhr = this;
                xhr.addEventListener('loadend', () => {
                  const url = xhr.responseURL || xhr.__dogebotUrl;
                  if (!isCollectListApiUrl(url)) return;
                  hookLog('xhr matched', { url, status: xhr.status, responseType: xhr.responseType });
                  const emit = (body) => emitCollectList({
                    source: 'xhr',
                    url,
                    status: xhr.status,
                    body
                  });
                  try {
                    if (!xhr.responseType || xhr.responseType === 'text') {
                      emit(xhr.responseText || '');
                      return;
                    }
                    if (xhr.responseType === 'json') {
                      emit(typeof xhr.response === 'string' ? xhr.response : JSON.stringify(xhr.response));
                      return;
                    }
                    if (xhr.responseType === 'arraybuffer') {
                      emit(decodeArrayBuffer(xhr.response));
                      return;
                    }
                    if (xhr.responseType === 'blob') {
                      readBlobText(xhr.response).then(emit).catch((error) => emitCollectList({
                        source: 'xhr',
                        url,
                        status: xhr.status,
                        error: error instanceof Error ? error.message : '读取 xhr blob 响应失败'
                      }));
                    }
                  } catch (error) {
                    emitCollectList({
                      source: 'xhr',
                      url,
                      status: xhr.status,
                      error: error instanceof Error ? error.message : '读取 xhr 响应失败'
                    });
                  }
                }, { once: true });
                return originalXhrSend.apply(this, arguments);
              };
              }
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
  if (douyinUseFetchDebuggerCapture) {
    devtools.on('message', (_event, method, params) => {
      if (method !== 'Fetch.requestPaused') return;
      const requestId = params.requestId;
      const url = params.request?.url;
      const continueRequest = () => {
        devtools.sendCommand('Fetch.continueRequest', { requestId }).catch(() => undefined);
      };
      if (typeof url !== 'string' || params.request?.method === 'OPTIONS' || !isCollectListUrl(url)) {
        continueRequest();
        return;
      }
      logDouyin('Fetch matched response', { requestId, url });
      devtools.sendCommand('Fetch.getResponseBody', { requestId })
        .then((result) => {
          const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
          logDouyin('Fetch response body captured', { requestId, length: body.length });
          handleCapturedCollectsVideoList({
            source: 'fetch-debugger',
            url,
            status: 200,
            body,
            receivedAt: new Date().toISOString()
          });
        })
        .catch((error) => {
          logDouyin('Fetch response body failed', error instanceof Error ? error.message : error);
          handleCapturedCollectsVideoList({
            source: 'fetch-debugger',
            url,
            status: 0,
            error: error instanceof Error ? error.message : '读取响应失败',
            receivedAt: new Date().toISOString()
          });
        })
        .finally(continueRequest);
    });
  }
}

function handleCapturedCollectsVideoList(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const data = payload as { url?: unknown; status?: unknown; body?: unknown; error?: unknown; source?: unknown; receivedAt?: unknown };
  if (typeof data.url !== 'string' || !isCollectListUrl(data.url)) {
    logDouyin('ignored collect list payload', { url: data.url, source: data.source });
    return;
  }
  const result = {
    url: data.url,
    status: typeof data.status === 'number' ? data.status : Number(data.status || 0),
    body: typeof data.body === 'string' ? data.body : '',
    error: typeof data.error === 'string' ? data.error : undefined,
    source: typeof data.source === 'string' ? data.source : 'page-hook',
    receivedAt: typeof data.receivedAt === 'string' ? data.receivedAt : new Date().toISOString()
  };
  logDouyin('page hook response captured', {
    url: result.url,
    status: result.status,
    source: result.source,
    length: result.body.length,
    error: result.error
  });
  mainWindow?.webContents.send('douyin:collects-video-list', result);
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
  douyinNextRunAt = new Date(Date.now() + delayMs).toISOString();
  monitorTimer = setTimeout(() => void runMonitorTick(), delayMs);
  sendMonitorState();
  logDouyin('monitor next tick scheduled', {
    mode: douyinIntervalMode,
    delayMs,
    sameIdsCount: douyinSameIdsCount,
    retryLimit: douyinRetryLimit
  });
}

async function runMonitorTick() {
  if (!douyinMonitorRunning) return;
  if (douyinTickRunning) {
    logDouyin('monitor tick skipped: already running');
    return;
  }
  douyinTickRunning = true;
  douyinNextRunAt = '';
  sendMonitorState();
  logDouyin('monitor tick start', { clickText, skipClick: douyinSkipClick });
  try {
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
  } finally {
    douyinTickRunning = false;
    scheduleMonitorTick();
  }
}

function stopMonitor() {
  douyinMonitorRunning = false;
  if (monitorTimer) clearTimeout(monitorTimer);
  monitorTimer = undefined;
  douyinNextRunAt = '';
  sendMonitorState();
  logDouyin('monitor stopped');
}

ipcMain.on('douyin:collects-video-list-captured', (event, payload: unknown) => {
  if (!douyinWindow || event.sender !== douyinWindow.webContents) {
    logDouyin('ignored collect list payload from unknown sender');
    return;
  }
  handleCapturedCollectsVideoList(payload);
});

ipcMain.on('douyin:hook-log', (event, payload: unknown) => {
  if (!douyinWindow || event.sender !== douyinWindow.webContents) return;
  logDouyin('page hook log', payload);
});

ipcMain.on('douyin:preload-ready', (event, payload: unknown) => {
  if (!douyinWindow || event.sender !== douyinWindow.webContents) return;
  logDouyin('page preload ready', payload);
});

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
  douyinNextRunAt = '';
  sendMonitorState();
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
  sendMonitorState();
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

ipcMain.handle('douyin:refresh-now', async () => {
  logDouyin('ipc refresh-now');
  if (!douyinMonitorRunning) throw new Error('监听未启动');
  if (monitorTimer) clearTimeout(monitorTimer);
  monitorTimer = undefined;
  douyinNextRunAt = '';
  await runMonitorTick();
});

ipcMain.handle('douyin:get-monitor-state', () => currentMonitorState());

app.whenReady().then(() => {
  registerBlockedDeeplinkHandlers();
  createTray();
  createWindow();
});
app.on('before-quit', () => {
  appQuitting = true;
});
app.on('window-all-closed', () => {
  if (appQuitting) app.quit();
});
app.on('activate', () => {
  showMainWindow();
});
