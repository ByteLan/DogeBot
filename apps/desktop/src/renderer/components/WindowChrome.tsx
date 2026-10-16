import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@arco-design/web-react';
import { IconClose, IconMinus } from '@arco-design/web-react/icon';
import type { DesktopWindowState } from '../../shared/types';
import '../types';
import './window-chrome.css';

function reportWindowError(error: unknown) {
  console.error('[desktop window] 窗口操作失败', { error: error instanceof Error ? error.message : String(error) });
}

export function WindowChrome({ children }: { children: ReactNode }) {
  const bridge = window.desktopWindow;
  const [state, setState] = useState<DesktopWindowState>({ maximized: false, focused: true, visible: false });

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let receivedState = false;
    const unsubscribe = bridge.onStateChanged((next) => {
      receivedState = true;
      if (active) setState(next);
    });
    bridge.getState().then((next) => {
      if (active && !receivedState) setState(next);
    }).catch(reportWindowError);
    return () => { active = false; unsubscribe(); };
  }, [bridge]);

  if (!bridge) return <>{children}</>;

  return (
    <div className="desktop-window" data-platform={bridge.platform} data-focused={state.focused} data-maximized={state.maximized}>
      <header className="desktop-titlebar" aria-label="DogeBot 窗口标题栏">
        <span className="desktop-titlebar-name">DogeBot</span>
        {bridge.platform !== 'darwin' && <div className="desktop-window-controls" role="group" aria-label="窗口操作">
          <Button type="text" className="desktop-window-button" aria-label="最小化" onClick={() => { void bridge.minimize().catch(reportWindowError); }}>
            <IconMinus />
          </Button>
          <Button type="text" className="desktop-window-button" aria-label={state.maximized ? '还原' : '最大化'} onClick={() => { void bridge.toggleMaximize().catch(reportWindowError); }}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
              {state.maximized
                ? <><path d="M5.5 5.5V2.5h8v8h-3" /><rect x="2.5" y="5.5" width="8" height="8" /></>
                : <rect x="3" y="3" width="10" height="10" />}
            </svg>
          </Button>
          <Button type="text" className="desktop-window-button desktop-window-close" aria-label="关闭到托盘" onClick={() => { void bridge.close().catch(reportWindowError); }}>
            <IconClose />
          </Button>
        </div>}
      </header>
      <div className="desktop-window-content">{children}</div>
    </div>
  );
}
