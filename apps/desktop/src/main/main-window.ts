import { pathToFileURL } from 'node:url';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { indexHtmlPath, preloadPath } from './paths.js';
import { state } from './douyin/state.js';
import { sendTasksState } from './douyin/monitor.js';
import { WindowIpc } from '../shared/ipc-channels.js';
import type { DesktopWindowState } from '../shared/types.js';

function windowState(win: BrowserWindow): DesktopWindowState {
  return { maximized: win.isMaximized(), focused: win.isFocused() };
}

export function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const win = state.mainWindow;
  if (!win || win.isDestroyed() || event.sender !== win.webContents
    || event.senderFrame !== win.webContents.mainFrame
    || event.senderFrame.url !== pathToFileURL(indexHtmlPath).href) {
    throw new Error('Window controls are only available to the main application page');
  }
  return win;
}

export function registerWindowIpc() {
  ipcMain.handle(WindowIpc.getState, (event) => windowState(senderWindow(event)));
  ipcMain.handle(WindowIpc.minimize, (event) => {
    const win = senderWindow(event);
    if (process.platform === 'darwin') win.minimize();
    else win.hide();
  });
  ipcMain.handle(WindowIpc.toggleMaximize, (event) => {
    const win = senderWindow(event);
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle(WindowIpc.close, (event) => { senderWindow(event).close(); });
}

export function showMainWindow() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) createWindow();
  if (!state.mainWindow) return;
  if (state.mainWindow.isMinimized()) state.mainWindow.restore();
  state.mainWindow.show();
  state.mainWindow.focus();
  sendTasksState();
}

export function hideMainWindowToTray() {
  state.mainWindow?.hide();
}

export function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: 'DogeBot',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 10 } }
      : { frame: false }),
    backgroundColor: '#f0f3f8',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath
    }
  });
  state.mainWindow = win;
  win.setMenu(null);
  const publishWindowState = () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(WindowIpc.stateChanged, windowState(win));
    }
  };
  win.on('maximize', publishWindowState);
  win.on('unmaximize', publishWindowState);
  win.on('focus', publishWindowState);
  win.on('blur', publishWindowState);
  win.webContents.on('did-finish-load', publishWindowState);
  win.on('close', (event) => {
    if (state.appQuitting) return;
    event.preventDefault();
    hideMainWindowToTray();
  });
  win.on('minimize', () => {
    if (process.platform !== 'darwin') hideMainWindowToTray();
  });
  win.on('closed', () => {
    if (state.mainWindow === win) state.mainWindow = undefined;
  });
  win.loadFile(indexHtmlPath);
}
