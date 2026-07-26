import type { DouyinTaskConfig, DouyinMonitorSharedConfig, DouyinMonitorState } from '../shared/types';

export type { DouyinMonitorSharedConfig, DouyinMonitorState };
export type DouyinMonitorTaskPayload = DouyinTaskConfig;

export type Bot = {
  id: number;
  name: string;
  appId: string;
  domain: string;
  botName: string | null;
  botOpenId: string | null;
  webhookPath: string;
};

export type QrBegin = {
  deviceCode: string;
  qrUrl: string;
  interval: number;
  expireIn: number;
  domain: string;
};

export type Connection = {
  botId: number;
  status: string;
  error?: string;
};

export type LoginForm = {
  username: string;
  password: string;
};

export type BotForm = {
  name: string;
  domain: string;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
};

export type DouyinTask = {
  id: string;
  enabled: boolean;
  favoriteUrl: string;
  collectListUrl: string;
  requestUrlFilter: string;
  clickText: string;
  skipClick: boolean;
};

export type DouyinBridge = {
  openLogin: () => Promise<void>;
  startMonitor: (tasks: DouyinMonitorTaskPayload[], sharedConfig?: DouyinMonitorSharedConfig) => Promise<void>;
  stopMonitor: () => Promise<void>;
  refreshNow: () => Promise<void>;
  getMonitorState: () => Promise<DouyinMonitorState>;
  setHidden: (hidden: boolean) => Promise<void>;
  onClickResult: (listener: (data: unknown) => void) => () => void;
  onCollectsVideoList: (listener: (data: unknown) => void) => () => void;
  onMonitorState: (listener: (data: DouyinMonitorState) => void) => () => void;
};

export type DouyinEvent = {
  id: string;
  title: string;
  data: unknown;
};

export type DouyinCollectResult = {
  taskId?: string;
  taskClickText?: string;
  taskFavoriteUrl?: string;
  taskCollectListUrl?: string;
  taskRequestUrlFilter?: string;
  url?: string;
  status?: number;
  body?: string;
  error?: string;
  source?: string;
  receivedAt?: string;
  awemeIds?: string[];
  changed?: boolean;
};

export type DouyinClickResult = {
  taskId?: string;
  taskClickText?: string;
  clicked?: boolean;
  reason?: string;
  text?: string;
  skipped?: boolean;
  clickedAt?: string;
};

declare global {
  interface Window {
    douyin?: DouyinBridge;
  }
}
