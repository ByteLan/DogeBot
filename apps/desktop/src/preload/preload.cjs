const { contextBridge, ipcRenderer } = require('electron');

console.log('[douyin preload] loaded');

// 注意：channel 字面量需与 src/shared/ipc-channels.ts 的 DouyinIpc 保持一致。
contextBridge.exposeInMainWorld('douyin', {
  openLogin: (partition) => {
    console.log('[douyin preload] openLogin', partition);
    return ipcRenderer.invoke('douyin:open-login', partition);
  },
  startTask: (task) => {
    console.log('[douyin preload] startTask', task && task.id);
    return ipcRenderer.invoke('douyin:start-task', task);
  },
  startAll: (tasks) => {
    console.log('[douyin preload] startAll', Array.isArray(tasks) ? tasks.length : 0);
    return ipcRenderer.invoke('douyin:start-all', tasks);
  },
  stopTask: (taskId, destroyWindow) => {
    console.log('[douyin preload] stopTask', taskId, destroyWindow);
    return ipcRenderer.invoke('douyin:stop-task', taskId, destroyWindow);
  },
  stopAll: () => {
    console.log('[douyin preload] stopAll');
    return ipcRenderer.invoke('douyin:stop-all');
  },
  refreshTask: (taskId) => {
    console.log('[douyin preload] refreshTask', taskId);
    return ipcRenderer.invoke('douyin:refresh-task', taskId);
  },
  setTaskHidden: (taskId, hidden) => {
    console.log('[douyin preload] setTaskHidden', taskId, hidden);
    return ipcRenderer.invoke('douyin:set-task-hidden', taskId, hidden);
  },
  getTasksState: () => {
    console.log('[douyin preload] getTasksState');
    return ipcRenderer.invoke('douyin:get-tasks-state');
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
  onTasksState: (listener) => {
    const handler = (_event, data) => listener(data);
    ipcRenderer.on('douyin:tasks-state', handler);
    return () => ipcRenderer.off('douyin:tasks-state', handler);
  }
});
