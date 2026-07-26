// IPC channel 名称的单一来源（main 进程与 renderer 类型层引用）。
// 注意：src/preload/*.cjs 为 CommonJS，无法 import 本模块，其中的字面量需与此保持一致。
export const DouyinIpc = {
  // renderer -> main（每任务 / 全局 / 登录）
  openLogin: 'douyin:open-login',
  startTask: 'douyin:start-task',
  stopTask: 'douyin:stop-task',
  refreshTask: 'douyin:refresh-task',
  startAll: 'douyin:start-all',
  stopAll: 'douyin:stop-all',
  setTaskHidden: 'douyin:set-task-hidden',
  getTasksState: 'douyin:get-tasks-state',
  // main -> renderer
  clickResult: 'douyin:click-result',
  collectsVideoList: 'douyin:collects-video-list',
  tasksState: 'douyin:tasks-state',
  // 抖音窗口 -> main
  collectsVideoListCaptured: 'douyin:collects-video-list-captured',
  hookLog: 'douyin:hook-log',
  preloadReady: 'douyin:preload-ready',
  // main -> 抖音窗口
  updateCaptureConfig: 'douyin:update-capture-config'
} as const;
