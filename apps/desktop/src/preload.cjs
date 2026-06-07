const { contextBridge, ipcRenderer } = require('electron');

console.log('[douyin preload] loaded');

contextBridge.exposeInMainWorld('douyin', {
  openLogin: () => {
    console.log('[douyin preload] openLogin');
    return ipcRenderer.invoke('douyin:open-login');
  },
  startMonitor: (clickText, hidden, showOnClickFailure, collectsId, skipClick, shortIntervalSeconds, longIntervalSeconds, retryLimit) => {
    console.log('[douyin preload] startMonitor', { clickText, hidden, showOnClickFailure, collectsId, skipClick, shortIntervalSeconds, longIntervalSeconds, retryLimit });
    return ipcRenderer.invoke('douyin:start-monitor', clickText, hidden, showOnClickFailure, collectsId, skipClick, shortIntervalSeconds, longIntervalSeconds, retryLimit);
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
  reportAwemeIds: (ids) => {
    console.log('[douyin preload] reportAwemeIds', { count: Array.isArray(ids) ? ids.length : 0 });
    return ipcRenderer.invoke('douyin:report-aweme-ids', ids);
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
