// 在 main 与 renderer 之间共享的抖音监听相关类型。

export type DouyinTaskConfig = {
  id: string;
  favoriteUrl: string;
  collectListUrl: string;
  requestUrlFilter: string;
  clickText: string;
  skipClick: boolean;
};

export type DouyinMonitorSharedConfig = {
  hidden?: boolean;
  showOnClickFailure?: boolean;
  shortIntervalSeconds?: number;
  longIntervalSeconds?: number;
  retryLimit?: number;
};

export type DouyinMonitorState = {
  running: boolean;
  mode: 'short' | 'long';
  currentIntervalSeconds: number;
  shortIntervalSeconds: number;
  longIntervalSeconds: number;
  sameIdsCount: number;
  retryLimit: number;
  nextRunAt: string;
  tickRunning: boolean;
  taskCount: number;
  activeTaskId: string;
  activeTaskLabel: string;
};
