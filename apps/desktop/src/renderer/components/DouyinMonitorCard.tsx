import React, { type Dispatch, type SetStateAction } from 'react';
import { Alert, Button, Card, Form, Grid, InputNumber, Space, Switch, Typography } from '@arco-design/web-react';
import type { DouyinEvent, DouyinMonitorState, DouyinTask } from '../types';
import { DouyinTaskCard } from './DouyinTaskCard';

const { Text, Paragraph } = Typography;
const { Row, Col } = Grid;

export function DouyinMonitorCard(props: {
  douyinShortIntervalSeconds: number;
  setDouyinShortIntervalSeconds: Dispatch<SetStateAction<number>>;
  douyinLongIntervalSeconds: number;
  setDouyinLongIntervalSeconds: Dispatch<SetStateAction<number>>;
  douyinRetryLimit: number;
  setDouyinRetryLimit: Dispatch<SetStateAction<number>>;
  douyinRunHidden: boolean;
  setDouyinRunHidden: Dispatch<SetStateAction<boolean>>;
  douyinShowOnClickFailure: boolean;
  setDouyinShowOnClickFailure: Dispatch<SetStateAction<boolean>>;
  douyinStatus: string;
  setDouyinStatus: Dispatch<SetStateAction<string>>;
  douyinMonitorState: DouyinMonitorState;
  onOpenLogin: () => void;
  onAddTask: () => void;
  onStartMonitor: () => void;
  onRefreshNow: () => void;
  onStopMonitor: () => void;
  douyinTasks: DouyinTask[];
  favoriteUrlOptions: string[];
  collectListUrlOptions: string[];
  requestUrlFilterOptions: string[];
  douyinTaskStatusMap: Record<string, string>;
  douyinTaskEvents: Record<string, DouyinEvent[]>;
  updateDouyinTask: (taskId: string, patch: Partial<DouyinTask>) => void;
  removeDouyinTask: (taskId: string) => void;
  deleteHistoryValue: (currentValue: string, setHistory: Dispatch<SetStateAction<string[]>>) => void;
  setFavoriteUrlHistory: Dispatch<SetStateAction<string[]>>;
  setCollectListUrlHistory: Dispatch<SetStateAction<string[]>>;
  setRequestUrlFilterHistory: Dispatch<SetStateAction<string[]>>;
}) {
  const {
    douyinShortIntervalSeconds,
    setDouyinShortIntervalSeconds,
    douyinLongIntervalSeconds,
    setDouyinLongIntervalSeconds,
    douyinRetryLimit,
    setDouyinRetryLimit,
    douyinRunHidden,
    setDouyinRunHidden,
    douyinShowOnClickFailure,
    setDouyinShowOnClickFailure,
    douyinStatus,
    setDouyinStatus,
    douyinMonitorState,
    onOpenLogin,
    onAddTask,
    onStartMonitor,
    onRefreshNow,
    onStopMonitor,
    douyinTasks,
    favoriteUrlOptions,
    collectListUrlOptions,
    requestUrlFilterOptions,
    douyinTaskStatusMap,
    douyinTaskEvents,
    updateDouyinTask,
    removeDouyinTask,
    deleteHistoryValue,
    setFavoriteUrlHistory,
    setCollectListUrlHistory,
    setRequestUrlFilterHistory
  } = props;
  return (
    <Card title="抖音收藏监听">
      <Paragraph type="secondary">
        登录态保存在本机 Electron 持久会话中。共享配置包括刷新间隔、retry、隐藏窗口和点击失败后是否弹到前台；每个活跃任务会按顺序执行，并各自维护接口返回日志。
      </Paragraph>
      <Form layout="vertical">
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item label="短间隔（秒）">
              <InputNumber min={1} precision={0} value={douyinShortIntervalSeconds} onChange={(value) => setDouyinShortIntervalSeconds(Number(value) > 0 ? Number(value) : 10)} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="长间隔（秒）">
              <InputNumber min={1} precision={0} value={douyinLongIntervalSeconds} onChange={(value) => setDouyinLongIntervalSeconds(Number(value) > 0 ? Number(value) : 60)} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="retry 次数">
              <InputNumber min={1} precision={0} value={douyinRetryLimit} onChange={(value) => setDouyinRetryLimit(Number(value) > 0 ? Number(value) : 3)} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item label="执行方式">
          <Space direction="vertical" align="start">
            <Space>
              <Switch
                checked={douyinRunHidden}
                onChange={(checked) => {
                  setDouyinRunHidden(checked);
                  window.douyin?.setHidden(checked).catch((error) => {
                    console.error('[douyin renderer] set hidden failed', error);
                    setDouyinStatus(error instanceof Error ? error.message : '切换 Douyin 窗口显示状态失败');
                  });
                }}
              />
              <Text type="secondary">{douyinRunHidden ? '隐藏 Douyin 窗口后台执行' : '显示 Douyin 窗口前台执行'}</Text>
            </Space>
            <Space>
              <Switch checked={douyinShowOnClickFailure} onChange={setDouyinShowOnClickFailure} />
              <Text type="secondary">点击失败立即弹到前台</Text>
            </Space>
          </Space>
        </Form.Item>
        <Space>
          <Button type="primary" onClick={onOpenLogin}>登录 douyin.com</Button>
          <Button onClick={onAddTask}>新增任务</Button>
          <Button onClick={onStartMonitor}>开始监听</Button>
          <Button onClick={onRefreshNow} disabled={!douyinMonitorState.running || douyinMonitorState.tickRunning}>立即刷新</Button>
          <Button onClick={onStopMonitor}>停止监听</Button>
        </Space>
      </Form>
      <Alert
        className="douyin-status"
        type="info"
        content={(
          <Space direction="vertical" size={2}>
            <Text>{douyinStatus}</Text>
            <Text>
              当前刷新间隔：{douyinMonitorState.currentIntervalSeconds}s（{douyinMonitorState.mode === 'short' ? '短间隔' : '长间隔'}）；
              retry：{douyinMonitorState.sameIdsCount}/{douyinMonitorState.retryLimit}；
              活跃任务：{douyinMonitorState.taskCount}；
              状态：{douyinMonitorState.tickRunning ? '刷新中' : douyinMonitorState.running ? '等待下次刷新' : '未运行'}
              {douyinMonitorState.activeTaskLabel ? `；当前任务：${douyinMonitorState.activeTaskLabel}` : ''}
              {douyinMonitorState.nextRunAt ? `；下次刷新：${new Date(douyinMonitorState.nextRunAt).toLocaleString()}` : ''}
            </Text>
          </Space>
        )}
      />

      <Space direction="vertical" className="douyin-task-list">
        {douyinTasks.map((task, index) => (
          <DouyinTaskCard
            key={task.id}
            task={task}
            index={index}
            favoriteUrlOptions={favoriteUrlOptions}
            collectListUrlOptions={collectListUrlOptions}
            requestUrlFilterOptions={requestUrlFilterOptions}
            events={douyinTaskEvents[task.id] || []}
            statusText={douyinTaskStatusMap[task.id] || '未开始'}
            updateDouyinTask={updateDouyinTask}
            removeDouyinTask={removeDouyinTask}
            deleteHistoryValue={deleteHistoryValue}
            setFavoriteUrlHistory={setFavoriteUrlHistory}
            setCollectListUrlHistory={setCollectListUrlHistory}
            setRequestUrlFilterHistory={setRequestUrlFilterHistory}
          />
        ))}
      </Space>
    </Card>
  );
}
