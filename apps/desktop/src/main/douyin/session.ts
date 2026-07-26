import { session } from 'electron';
import { logDouyin } from '../log.js';
import { isAllowedNavigationUrl } from '../navigation.js';
import { chromeVersion, douyinUserAgent } from './constants.js';
import { state } from './state.js';

// 按 partition 配置一次（UA / 请求头改写 / 自定义协议拦截）。
// 多个窗口复用同一 partition 时不会重复挂 webRequest 监听。
export function configureDouyinSession(partition: string) {
  const ses = session.fromPartition(partition);
  if (state.configuredPartitions.has(partition)) return ses;
  state.configuredPartitions.add(partition);
  ses.setUserAgent(douyinUserAgent);
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://www.douyin.com/*', '*://*.douyin.com/*'] }, (details: any, callback: any) => {
    const headers = { ...details.requestHeaders };
    headers['User-Agent'] = douyinUserAgent;
    headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
    headers['sec-ch-ua'] = '"Chromium";v="' + chromeVersion.split('.')[0] + '", "Google Chrome";v="' + chromeVersion.split('.')[0] + '", "Not.A/Brand";v="99"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"macOS"';
    delete headers['user-agent'];
    delete headers['accept-language'];
    delete headers['Sec-Ch-Ua'];
    delete headers['Sec-Ch-Ua-Mobile'];
    delete headers['Sec-Ch-Ua-Platform'];
    callback({ requestHeaders: headers });
  });
  ses.webRequest.onBeforeRequest((details: any, callback: any) => {
    if (isAllowedNavigationUrl(details.url)) {
      callback({});
      return;
    }
    logDouyin('blocked custom protocol request', { url: details.url, resourceType: details.resourceType });
    callback({ cancel: true });
  });
  logDouyin('session configured', { userAgent: douyinUserAgent, partition });
  return ses;
}
