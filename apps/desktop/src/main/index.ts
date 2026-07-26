import { app, type BrowserWindow } from 'electron';
import { logDouyin } from './log.js';
import { installDevToolsShortcut, isBlockedDeeplinkUrl, registerBlockedDeeplinkHandlers } from './navigation.js';
import { createTray } from './tray.js';
import { createWindow, showMainWindow } from './main-window.js';
import { registerDouyinIpc } from './douyin/ipc.js';
import { state } from './douyin/state.js';

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('lang', 'zh-CN');

app.on('open-url', (event: any, url: string) => {
  if (!isBlockedDeeplinkUrl(url)) return;
  event.preventDefault();
  logDouyin('swallowed registered deeplink', url);
});

app.on('browser-window-created', (_event: any, win: BrowserWindow) => {
  installDevToolsShortcut(win);
});

registerDouyinIpc();

app.whenReady().then(() => {
  registerBlockedDeeplinkHandlers();
  createTray();
  createWindow();
});
app.on('before-quit', () => {
  state.appQuitting = true;
});
app.on('window-all-closed', () => {
  if (state.appQuitting) app.quit();
});
app.on('activate', () => {
  showMainWindow();
});
