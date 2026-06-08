const { contextBridge, ipcRenderer } = require('electron');

const hookSource = 'dogebot-douyin-hook';
const hookEvent = 'dogebot-douyin-hook-event';
const collectListEndpoint = 'https://www.douyin.com/aweme/v1/web/collects/video/list/';

function sendCapturedCollectsVideoList(payload) {
  if (!payload || typeof payload !== 'object') return;
  ipcRenderer.send('douyin:collects-video-list-captured', payload);
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
      const collectListEndpoint = ${JSON.stringify(collectListEndpoint)};
      const isCollectListApiUrl = (url) => {
        if (!url) return false;
        try {
          const parsed = new URL(String(url), location.href);
          return parsed.origin + parsed.pathname === collectListEndpoint;
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
        hasFetch: typeof originalFetch === 'function',
        hasXhr: typeof XMLHttpRequest !== 'undefined'
      });
    })();
  `;
  const script = document.createElement('script');
  script.textContent = source;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
}

ipcRenderer.send('douyin:preload-ready', { href: location.href });
try {
  if (document.documentElement || document.head || document.body) {
    injectPageHook();
  } else {
    window.addEventListener('DOMContentLoaded', injectPageHook, { once: true });
  }
} catch (error) {
  ipcRenderer.send('douyin:hook-log', {
    message: 'preload script inject failed',
    data: error instanceof Error ? error.message : String(error)
  });
}
console.log('[douyin page preload] loaded');
