// 在 main 与 renderer 之间共享的抖音监听相关类型。

// 主进程接收的单任务配置（每任务自持 partition / 定时 / 显隐 / 窗口回收策略）。
export type DouyinTaskConfig = {
  id: string;
  partition: string;
  favoriteUrl: string;
  collectListUrl: string;
  requestUrlFilter: string;
  clickText: string;
  skipClick: boolean;
  runHidden: boolean;
  showOnClickFailure: boolean;
  shortIntervalSeconds: number;
  longIntervalSeconds: number;
  retryLimit: number;
  destroyOnStop: boolean;
};

// renderer 侧「新任务默认值」用（顶部全局配置）。
export type DouyinMonitorSharedConfig = {
  hidden?: boolean;
  showOnClickFailure?: boolean;
  shortIntervalSeconds?: number;
  longIntervalSeconds?: number;
  retryLimit?: number;
};

// 单个任务的运行时状态（每任务独立，取代原全局 DouyinMonitorState）。
export type DouyinTaskState = {
  taskId: string;
  running: boolean;
  mode: 'short' | 'long';
  currentIntervalSeconds: number;
  shortIntervalSeconds: number;
  longIntervalSeconds: number;
  sameIdsCount: number;
  retryLimit: number;
  nextRunAt: string;
  tickRunning: boolean;
  windowOpen: boolean;
  hidden: boolean;
  activeTaskLabel: string;
};

// 用户可自定义增删的浏览器 partition（登录态按 partition 共享）。
export type DouyinPartition = {
  id: string;
  name: string;
};
