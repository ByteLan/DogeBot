// 在 main 与 renderer 之间共享的桌面能力与抖音监听类型。

export type DesktopWindowState = {
  maximized: boolean;
  focused: boolean;
  visible: boolean;
};

export type DesktopWindowBridge = {
  platform: 'darwin' | 'win32' | 'linux' | 'other';
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  getState: () => Promise<DesktopWindowState>;
  onStateChanged: (listener: (state: DesktopWindowState) => void) => () => void;
};

export type DesktopStartupSettings = {
  available: boolean;
  enabled: boolean;
  unavailableReason?: 'development' | 'platform';
  requiresApproval?: boolean;
};

export type DesktopSettingsBridge = {
  getStartup: () => Promise<DesktopStartupSettings>;
  setStartup: (enabled: boolean) => Promise<DesktopStartupSettings>;
};

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
