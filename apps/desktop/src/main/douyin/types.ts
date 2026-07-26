export type DouyinCollectCaptureMode = 'page-hook' | 'fetch-debugger';

export type DouyinTaskRunResult = {
  captured: boolean;
  changed: boolean;
  awemeIds: string[];
};

export type DouyinPendingCapture = {
  task: import('../../shared/types.js').DouyinTaskConfig;
  resolve: (result: DouyinTaskRunResult) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
};
