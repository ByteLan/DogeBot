const { contextBridge, ipcRenderer } = require('electron');

console.log('[douyin preload] loaded');

contextBridge.exposeInMainWorld('douyin', {
  openLogin: () => {
    console.log('[douyin preload] openLogin');
    return ipcRenderer.invoke('douyin:open-login');
  },
  startMonitor: (tasks, sharedConfig) => {
    console.log('[douyin preload] startMonitor', {
      taskCount: Array.isArray(tasks) ? tasks.length : 0,
      sharedConfig
    });
    return ipcRenderer.invoke('douyin:start-monitor', tasks, sharedConfig);
  },
  stopMonitor: () => {
    console.log('[douyin preload] stopMonitor');
    return ipcRenderer.invoke('douyin:stop-monitor');
  },
  refreshNow: () => {
    console.log('[douyin preload] refreshNow');
    return ipcRenderer.invoke('douyin:refresh-now');
  },
  getMonitorState: () => {
    console.log('[douyin preload] getMonitorState');
    return ipcRenderer.invoke('douyin:get-monitor-state');
  },
  setHidden: (hidden) => {
    console.log('[douyin preload] setHidden', hidden);
    return ipcRenderer.invoke('douyin:set-hidden', hidden);
  },
  onClickResult: (listener) => {
    const handler = (_event, data) => listener(data);
    ipcRenderer.on('douyin:click-result', handler);
    return () => ipcRenderer.off('douyin:click-result', handler);
  },
  onCollectsVideoList: (listener) => {
    const handler = (_event, data) => listener(data);
    ipcRenderer.on('douyin:collects-video-list', handler);
    return () => ipcRenderer.off('douyin:collects-video-list', handler);
  },
  onMonitorState: (listener) => {
    const handler = (_event, data) => listener(data);
    ipcRenderer.on('douyin:monitor-state', handler);
    return () => ipcRenderer.off('douyin:monitor-state', handler);
  }
});
