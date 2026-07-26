import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { ApiClient } from '../api';
import type { QrBegin } from '../types';

// 扫码注册轮询：与原 App 内的 useEffect 逐字一致，依赖数组保持 [api, loadBots, qrRegistration]。
export function useQrRegistration(params: {
  qrRegistration: QrBegin | undefined;
  api: ApiClient;
  loadBots: () => Promise<void>;
  setMessage: Dispatch<SetStateAction<string>>;
  setQrRegistration: Dispatch<SetStateAction<QrBegin | undefined>>;
}) {
  const { qrRegistration, api, loadBots, setMessage, setQrRegistration } = params;
  useEffect(() => {
    if (!qrRegistration) return;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = async (registration: QrBegin) => {
      if (stopped) return;
      if (Date.now() - startedAt > registration.expireIn * 1000) {
        setMessage('扫码已超时，请重新发起');
        setQrRegistration(undefined);
        return;
      }
      try {
        const result = await api<{ status: 'pending' | 'success' | 'denied' | 'expired'; domain: string; interval?: number }>('/api/feishu/qr-registration/poll', {
          method: 'POST',
          body: JSON.stringify({
            deviceCode: registration.deviceCode,
            domain: registration.domain,
            interval: registration.interval
          })
        });
        if (result.status === 'success') {
          setMessage('扫码绑定成功');
          setQrRegistration(undefined);
          await loadBots();
          return;
        }
        if (result.status === 'denied' || result.status === 'expired') {
          setMessage(result.status === 'denied' ? '扫码授权已拒绝' : '扫码已过期');
          setQrRegistration(undefined);
          return;
        }
        const next = { ...registration, domain: result.domain, interval: result.interval || registration.interval };
        timer = setTimeout(() => void poll(next), next.interval * 1000);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '扫码状态查询失败');
        timer = setTimeout(() => void poll(registration), registration.interval * 1000);
      }
    };
    timer = setTimeout(() => void poll(qrRegistration), qrRegistration.interval * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, loadBots, qrRegistration]);
}
