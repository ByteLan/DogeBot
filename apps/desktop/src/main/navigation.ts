import { app, type BrowserWindow } from 'electron';
import { logDouyin } from './log.js';
import { devToolsShortcutAttached } from './douyin/state.js';

export const blockedDeeplinkSchemes = ['bitbrowser'];

export function installDevToolsShortcut(win: BrowserWindow) {
  if (devToolsShortcutAttached.has(win)) return;
  devToolsShortcutAttached.add(win);
  win.webContents.on('before-input-event', (event: any, input: any) => {
    if (input.type !== 'keyDown' || input.key !== 'F12') return;
    event.preventDefault();
    if (win.webContents.isDevToolsOpened()) {
      win.webContents.closeDevTools();
      return;
    }
    win.webContents.openDevTools({ mode: 'detach' });
  });
}

export function isAllowedNavigationUrl(url: string) {
  if (!url) return false;
  if (url.startsWith('about:')) return true;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'ws:', 'wss:', 'blob:', 'data:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function isAllowedWindowOpenUrl(url: string) {
  if (!url) return false;
  if (url.startsWith('about:')) return true;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function isBlockedDeeplinkUrl(url: string) {
  try {
    return blockedDeeplinkSchemes.includes(new URL(url).protocol.replace(/:$/, ''));
  } catch {
    return false;
  }
}

export function registerBlockedDeeplinkHandlers() {
  if ((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp) {
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
