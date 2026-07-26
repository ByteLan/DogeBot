import { douyinUrl, defaultFavoriteUrl, defaultCollectListUrl } from '../../shared/constants.js';
import type { DouyinCollectCaptureMode } from './types.js';

export { douyinUrl, defaultFavoriteUrl, defaultCollectListUrl };

export const favoriteUrl = defaultFavoriteUrl;
export const collectListUrl = defaultCollectListUrl;

export const douyinCollectCaptureMode = 'page-hook' as DouyinCollectCaptureMode;
export const douyinUsePageHookCapture = douyinCollectCaptureMode === 'page-hook';
export const douyinUseFetchDebuggerCapture = douyinCollectCaptureMode === 'fetch-debugger';
export const douyinUseCdpPageHookCapture = false;
export const douyinPartition = 'persist:dogebot-douyin';
export const chromeVersion = process.versions.chrome || '120.0.0.0';
export const douyinUserAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
export const douyinCaptureWaitMs = 5_000;
export const douyinPageReadyWaitMs = 5_000;
export const douyinPostTaskPauseMs = 5_000;
export const douyinUaMetadata = {
  brands: [
    { brand: 'Chromium', version: chromeVersion.split('.')[0] },
    { brand: 'Google Chrome', version: chromeVersion.split('.')[0] },
    { brand: 'Not.A/Brand', version: '99' }
  ],
  mobile: false,
  platform: 'macOS'
};
