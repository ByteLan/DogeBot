import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Radio, Switch, Typography } from '@arco-design/web-react';
import type { DesktopStartupSettings } from '../../shared/types';
import type { OwnMessageAlignment } from '../feishu/chat/types';
import './settings.css';

export function SettingsPanel({ active, ownMessageAlignment, onOwnMessageAlignmentChange }: {
  active: boolean;
  ownMessageAlignment: OwnMessageAlignment;
  onOwnMessageAlignmentChange: (alignment: OwnMessageAlignment) => void;
}) {
  const [startup, setStartup] = useState<DesktopStartupSettings>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!active || !window.desktopSettings) return;
    const bridge = window.desktopSettings;
    let cancelled = false;
    let reading = false;
    const refresh = async () => {
      if (reading || savingRef.current) return;
      reading = true;
      setLoading(true);
      setError('');
      try {
        const result = await bridge.getStartup();
        if (!cancelled) setStartup(result);
      } catch (error) {
        if (!cancelled) {
          setStartup(undefined);
          setError(error instanceof Error ? error.message : '读取开机自启设置失败');
        }
      } finally {
        reading = false;
        if (!cancelled) setLoading(false);
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
    };
  }, [active, retry]);

  const changeStartup = async (enabled: boolean) => {
    if (!window.desktopSettings || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      setStartup(await window.desktopSettings.setStartup(enabled));
    } catch (error) {
      setStartup(undefined);
      setError(error instanceof Error ? error.message : '保存开机自启设置失败');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const startupHint = !window.desktopSettings ? '请在桌面客户端中设置开机自启。'
    : startup?.unavailableReason === 'development' ? '开发模式下不可设置，请使用安装版客户端。'
    : startup?.unavailableReason === 'platform' ? '当前系统暂不支持，请在 Windows 或 macOS 客户端中设置。'
    : startup?.requiresApproval ? '请在 macOS「系统设置 → 通用 → 登录项」中允许 DogeBot，再返回此页面。'
    : '登录电脑时自动启动 DogeBot，默认关闭。';

  return <section className="app-settings" aria-label="设置">
    <header className="app-settings-header">
      <Typography.Title heading={5}>设置</Typography.Title>
      <Typography.Text type="secondary">偏好设置自动保存，仅对当前设备生效</Typography.Text>
    </header>
    <Card title="常规" size="small">
      <div className="app-settings-row">
        <div className="app-settings-label">
          <Typography.Text id="startup-label">开机自启</Typography.Text>
          <Typography.Text type="secondary">{startupHint}</Typography.Text>
        </div>
        <Switch aria-labelledby="startup-label" checked={startup?.enabled ?? false}
          loading={loading || saving} disabled={!startup?.available || loading || saving} onChange={changeStartup} />
      </div>
      {error ? <Alert type="error" className="app-settings-error" content={error}
        action={<Button size="mini" type="text" onClick={() => setRetry((value) => value + 1)}>重试</Button>} /> : null}
    </Card>
    <Card title="聊天" size="small">
      <div className="app-settings-row">
        <div className="app-settings-label">
          <Typography.Text id="message-alignment-label">自己发出的消息气泡</Typography.Text>
          <Typography.Text type="secondary">调整群聊和话题内自己消息的位置，默认在右侧。</Typography.Text>
        </div>
        <Radio.Group type="button" size="small" value={ownMessageAlignment} aria-labelledby="message-alignment-label"
          onChange={(value) => {
            if (value === 'left' || value === 'right') onOwnMessageAlignmentChange(value);
          }}>
          <Radio value="left">左侧</Radio>
          <Radio value="right">右侧</Radio>
        </Radio.Group>
      </div>
    </Card>
  </section>;
}
