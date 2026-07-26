import { app, Menu, nativeImage, Tray } from 'electron';
import { state } from './douyin/state.js';
import { stopMonitor } from './douyin/monitor.js';
import { showMainWindow } from './main-window.js';

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

export function updateTrayMenu() {
  if (!state.tray) return;
  state.tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 DogeBot', click: showMainWindow },
    {
      label: '停止监听',
      click: () => stopMonitor(),
      enabled: state.douyinMonitorRunning
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        state.appQuitting = true;
        app.quit();
      }
    }
  ]));
}

export function createTray() {
  if (state.tray) return;
  state.tray = new Tray(buildTrayIcon());
  state.tray.setToolTip('DogeBot');
  updateTrayMenu();
  state.tray.on('click', showMainWindow);
}
