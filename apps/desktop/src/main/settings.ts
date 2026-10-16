import { app, ipcMain } from 'electron';
import { SettingsIpc } from '../shared/ipc-channels.js';
import type { DesktopStartupSettings } from '../shared/types.js';
import { senderWindow } from './main-window.js';

function loginItemOptions() {
  // Windows 使用 NSIS 安装，启动目标就是当前应用，不使用 Squirrel 的父目录启动器。
  return process.platform === 'win32' ? { path: process.execPath, args: [] as string[] } : {};
}

function getStartup(): DesktopStartupSettings {
  if (!app.isPackaged) return { available: false, enabled: false, unavailableReason: 'development' };
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return { available: false, enabled: false, unavailableReason: 'platform' };
  }
  const settings = app.getLoginItemSettings(loginItemOptions());
  return {
    available: true,
    enabled: settings.openAtLogin && (process.platform !== 'win32' || settings.executableWillLaunchAtLogin),
    requiresApproval: process.platform === 'darwin' && settings.status === 'requires-approval'
  };
}

export function registerSettingsIpc() {
  ipcMain.handle(SettingsIpc.getStartup, (event) => {
    senderWindow(event);
    return getStartup();
  });
  ipcMain.handle(SettingsIpc.setStartup, (event, enabled: unknown) => {
    senderWindow(event);
    if (typeof enabled !== 'boolean') throw new Error('开机自启设置必须为布尔值');
    if (!getStartup().available) throw new Error('请在 Windows 或 macOS 安装版客户端中设置开机自启');
    app.setLoginItemSettings({
      ...loginItemOptions(),
      openAtLogin: enabled,
      ...(process.platform === 'win32' ? { enabled } : {})
    });
    const result = getStartup();
    if (result.enabled !== enabled && !result.requiresApproval) {
      throw new Error('系统未应用开机自启设置，请检查系统的启动项权限后重试');
    }
    return result;
  });
}
