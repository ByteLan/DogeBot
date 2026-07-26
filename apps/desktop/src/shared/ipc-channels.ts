// IPC channel 名称的单一来源（main 进程与 renderer 类型层引用）。
// 注意：src/preload/*.cjs 为 CommonJS，无法 import 本模块，其中的字面量需与此保持一致。
export const DouyinIpc = {
  openLogin: 'douyin:open-login',
  startMonitor: 'douyin:start-monitor',
  stopMonitor: 'douyin:stop-monitor',
  refreshNow: 'douyin:refresh-now',
  getMonitorState: 'douyin:get-monitor-state',
  setHidden: 'douyin:set-hidden',
  clickResult: 'douyin:click-result',
  collectsVideoList: 'douyin:collects-video-list',
  monitorState: 'douyin:monitor-state',
  collectsVideoListCaptured: 'douyin:collects-video-list-captured',
  hookLog: 'douyin:hook-log',
  preloadReady: 'douyin:preload-ready',
  updateCaptureConfig: 'douyin:update-capture-config'
} as const;
