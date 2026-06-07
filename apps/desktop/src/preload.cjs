const { contextBridge, ipcRenderer } = require('electron');

console.log('[douyin preload] loaded');

contextBridge.exposeInMainWorld('douyin', {
  openLogin: () => {
    console.log('[douyin preload] openLogin');
    return ipcRenderer.invoke('douyin:open-login');
  },
  startMonitor: (clickText, hidden, showOnClickFailure, collectsId, skipClick) => {
    console.log('[douyin preload] startMonitor', { clickText, hidden, showOnClickFailure, collectsId, skipClick });
    return ipcRenderer.invoke('douyin:start-monitor', clickText, hidden, showOnClickFailure, collectsId, skipClick);
  },
  stopMonitor: () => {
    console.log('[douyin preload] stopMonitor');
    return ipcRenderer.invoke('douyin:stop-monitor');
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
  }
});
