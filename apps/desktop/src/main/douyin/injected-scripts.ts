// 抖音窗口的反检测 / 抓包注入脚本。模板内容与原 main.ts 中
// Page.addScriptToEvaluateOnNewDocument 的 source 逐字一致，仅将插值变量替换为函数参数。
export function buildStealthScript(params: {
  userAgent: string;
  uaMetadata: unknown;
  chromeVersion: string;
  useCdpPageHookCapture: boolean;
  collectListUrl: string;
}) {
  const { userAgent, uaMetadata, chromeVersion, useCdpPageHookCapture, collectListUrl } = params;
  return `
            (() => {
              if (window.__dogebotDouyinHookInstalled) return;
              window.__dogebotDouyinHookInstalled = true;
              const userAgent = ${JSON.stringify(userAgent)};
              const uaMetadata = ${JSON.stringify(uaMetadata)};
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
              if (${JSON.stringify(useCdpPageHookCapture)}) {
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
          `;
}
