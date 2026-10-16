import { useEffect, useState } from 'react';
import './types';

export function useWindowVisibility() {
  const bridge = window.desktopWindow;
  const [visible, setVisible] = useState(() => bridge ? false : document.visibilityState === 'visible');
  useEffect(() => {
    if (!bridge) {
      const update = () => setVisible(document.visibilityState === 'visible');
      update();
      document.addEventListener('visibilitychange', update);
      return () => document.removeEventListener('visibilitychange', update);
    }
    let active = true;
    let receivedState = false;
    const unsubscribe = bridge.onStateChanged((state) => {
      receivedState = true;
      if (active) setVisible(state.visible);
    });
    void bridge.getState().then((state) => {
      if (active && !receivedState) setVisible(state.visible);
    }).catch((error: unknown) => {
      console.error('[desktop window] 读取窗口可见性失败', { error: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return visible;
}
