const { contextBridge, ipcRenderer } = require('electron');

const hookSource = 'dogebot-douyin-hook';
const hookEvent = 'dogebot-douyin-hook-event';
const collectListEndpoint = 'https://www.douyin.com/aweme/v1/web/collects/video/list/';
const collectListConfigStorageKey = 'dogebot.douyinCollectListEndpoints';

function sendCapturedCollectsVideoList(payload) {
  if (!payload || typeof payload !== 'object') return;
  ipcRenderer.send('douyin:collects-video-list-captured', payload);
}

function normalizeCollectListEndpoints(value) {
  if (!Array.isArray(value)) return [collectListEndpoint];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const next = typeof item === 'string' ? item.trim() : '';
    if (!next || seen.has(next)) continue;
    seen.add(next);
    result.push(next);
  }
  return result.length > 0 ? result : [collectListEndpoint];
}

function readStoredCollectListEndpoints() {
  try {
    return normalizeCollectListEndpoints(JSON.parse(window.localStorage.getItem(collectListConfigStorageKey) || '[]'));
  } catch {
    return [collectListEndpoint];
  }
}

let collectListEndpoints = readStoredCollectListEndpoints();

function appendPageScript(source) {
  const target = document.documentElement || document.head || document.body;
  if (!target) return false;
  const script = document.createElement('script');
  script.textContent = source;
  target.appendChild(script);
  script.remove();
  return true;
}

function injectCaptureConfig(endpoints) {
  const source = `
    (() => {
      window.__dogebotDouyinCollectListEndpoints = ${JSON.stringify(endpoints)};
      try {
        window.localStorage.setItem(${JSON.stringify(collectListConfigStorageKey)}, JSON.stringify(${JSON.stringify(endpoints)}));
      } catch {}
    })();
  `;
  return appendPageScript(source);
}

contextBridge.exposeInMainWorld('__dogebotDouyinCapture', {
  sendCollectsVideoList: sendCapturedCollectsVideoList,
  log: (message, data) => ipcRenderer.send('douyin:hook-log', { message, data })
});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.source !== hookSource || data.type !== 'collects-video-list') return;
  sendCapturedCollectsVideoList(data.payload);
});

window.addEventListener(hookEvent, (event) => {
  try {
    const data = JSON.parse(event.detail);
    if (!data || data.source !== hookSource) return;
    if (data.type === 'collects-video-list') sendCapturedCollectsVideoList(data.payload);
    if (data.type === 'hook-log') ipcRenderer.send('douyin:hook-log', data.payload);
  } catch (error) {
    ipcRenderer.send('douyin:hook-log', {
      message: 'custom event parse failed',
      data: error instanceof Error ? error.message : String(error)
    });
  }
});

function injectPageHook() {
  const source = `
    (() => {
      if (window.__dogebotDouyinCaptureHookInstalled) return;
      window.__dogebotDouyinCaptureHookInstalled = true;
      const hookSource = ${JSON.stringify(hookSource)};
      const hookEvent = ${JSON.stringify(hookEvent)};
      const defaultCollectListEndpoint = ${JSON.stringify(collectListEndpoint)};
      const getCollectListEndpoints = () => {
        const endpoints = Array.isArray(window.__dogebotDouyinCollectListEndpoints) ? window.__dogebotDouyinCollectListEndpoints : [];
          if (endpoints.length > 0) return endpoints;
          try {
            const stored = JSON.parse(window.localStorage.getItem(${JSON.stringify(collectListConfigStorageKey)}) || '[]');
            return Array.isArray(stored) && stored.length > 0 ? stored : [defaultCollectListEndpoint];
          } catch {
            return [defaultCollectListEndpoint];
          }
      };
      const isCollectListApiUrl = (url) => {
        if (!url) return false;
        try {
          const parsed = new URL(String(url), location.href);
          return getCollectListEndpoints().includes(parsed.origin + parsed.pathname);
        } catch {
          return false;
        }
      };
      const dispatchToPreload = (type, payload) => {
        try {
          window.dispatchEvent(new CustomEvent(hookEvent, {
            detail: JSON.stringify({ source: hookSource, type, payload })
          }));
        } catch {}
      };
      const hookLog = (message, data) => dispatchToPreload('hook-log', { message, data });
      const emitCollectList = (payload) => {
        dispatchToPreload('collects-video-list', {
          ...payload,
          receivedAt: new Date().toISOString()
        });
      };
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
            hookLog('preload fetch matched', { requestUrl, responseUrl, status: response.status });
            response.clone().text()
              .then((body) => emitCollectList({
                source: 'preload-fetch',
                url: responseUrl || requestUrl,
                status: response.status,
                body
              }))
              .catch((error) => emitCollectList({
                source: 'preload-fetch',
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
          hookLog('preload xhr matched', { url, status: xhr.status, responseType: xhr.responseType });
          const emit = (body) => emitCollectList({
            source: 'preload-xhr',
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
                source: 'preload-xhr',
                url,
                status: xhr.status,
                error: error instanceof Error ? error.message : '读取 xhr blob 响应失败'
              }));
            }
          } catch (error) {
            emitCollectList({
              source: 'preload-xhr',
              url,
              status: xhr.status,
              error: error instanceof Error ? error.message : '读取 xhr 响应失败'
            });
          }
        }, { once: true });
        return originalXhrSend.apply(this, arguments);
      };
      hookLog('preload script installed', {
        href: location.href,
        collectListEndpoints: getCollectListEndpoints(),
        hasFetch: typeof originalFetch === 'function',
        hasXhr: typeof XMLHttpRequest !== 'undefined'
      });
    })();
  `;
  return appendPageScript(source);
}

function installPageHookWithConfig() {
  if (!document.documentElement && !document.head && !document.body) return false;
  injectCaptureConfig(collectListEndpoints);
  injectPageHook();
  return true;
}

ipcRenderer.send('douyin:preload-ready', { href: location.href });
try {
  if (!installPageHookWithConfig()) window.addEventListener('DOMContentLoaded', installPageHookWithConfig, { once: true });
} catch (error) {
  ipcRenderer.send('douyin:hook-log', {
    message: 'preload script inject failed',
    data: error instanceof Error ? error.message : String(error)
  });
}
ipcRenderer.on('douyin:update-capture-config', (_event, payload) => {
  collectListEndpoints = normalizeCollectListEndpoints(payload && payload.collectListEndpoints);
  try {
    const installed = installPageHookWithConfig();
    ipcRenderer.send('douyin:hook-log', {
      message: 'capture config updated',
      data: { collectListEndpoints, installed }
    });
  } catch (error) {
    ipcRenderer.send('douyin:hook-log', {
      message: 'capture config update failed',
      data: error instanceof Error ? error.message : String(error)
    });
  }
});
console.log('[douyin page preload] loaded');
