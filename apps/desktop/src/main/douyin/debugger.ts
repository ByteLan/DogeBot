import type { BrowserWindow } from 'electron';
import { logDouyin } from '../log.js';
import {
  chromeVersion,
  collectListUrl,
  douyinUaMetadata,
  douyinUseCdpPageHookCapture,
  douyinUseFetchDebuggerCapture,
  douyinUserAgent
} from './constants.js';
import { buildStealthScript } from './injected-scripts.js';
import { debugListenerAttached, debuggerDetachListenerAttached } from './state.js';

export function attachDouyinDebugger(win: BrowserWindow) {
  if (debugListenerAttached.has(win)) return;
  const { debugger: devtools } = win.webContents;
  if (!devtools.isAttached()) {
    try {
      devtools.attach('1.3');
      if (!debuggerDetachListenerAttached.has(win)) {
        debuggerDetachListenerAttached.add(win);
        devtools.on('detach', (_event: any, reason: string) => {
          logDouyin('debugger detached', reason);
          debugListenerAttached.delete(win);
          setTimeout(() => attachDouyinDebugger(win), 1000);
        });
      }
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
          source: buildStealthScript({
            userAgent: douyinUserAgent,
            uaMetadata: douyinUaMetadata,
            chromeVersion,
            useCdpPageHookCapture: douyinUseCdpPageHookCapture,
            collectListUrl
          })
        })
        .catch((error) => logDouyin('navigator override failed', error instanceof Error ? error.message : error));
      logDouyin('debugger attached');
    } catch {
      logDouyin('debugger attach failed');
      return;
    }
  }
  debugListenerAttached.add(win);
}
