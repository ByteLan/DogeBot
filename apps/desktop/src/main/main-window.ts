import { BrowserWindow } from 'electron';
import { indexHtmlPath, preloadPath } from './paths.js';
import { state } from './douyin/state.js';
import { sendMonitorState } from './douyin/monitor.js';

export function showMainWindow() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) createWindow();
  if (!state.mainWindow) return;
  if (state.mainWindow.isMinimized()) state.mainWindow.restore();
  state.mainWindow.show();
  state.mainWindow.focus();
  sendMonitorState();
}

export function hideMainWindowToTray() {
  state.mainWindow?.hide();
}

export function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    title: 'DogeBot',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath
    }
  });
  state.mainWindow = win;
  win.on('close', (event: any) => {
    if (state.appQuitting) return;
    event.preventDefault();
    hideMainWindowToTray();
  });
  win.on('minimize', () => {
    hideMainWindowToTray();
  });
  win.on('closed', () => {
    if (state.mainWindow === win) state.mainWindow = undefined;
  });
  win.loadFile(indexHtmlPath);
}
