import React, { type Dispatch, type SetStateAction } from 'react';
import { Alert, Button, Card, Form, Grid, InputNumber, Space, Switch, Typography } from '@arco-design/web-react';
import type { DouyinEvent, DouyinPartition, DouyinTask, DouyinTaskState } from '../types';
import { DouyinTaskCard } from './DouyinTaskCard';
import { PartitionManagerCard } from './PartitionManagerCard';

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
  partitions: DouyinPartition[];
  onAddPartition: (name: string) => void;
  onRemovePartition: (partitionId: string) => void;
  onLoginPartition: (partitionId: string) => void;
  onAddTask: () => void;
  onStartAll: () => void;
  onStopAll: () => void;
  douyinTasks: DouyinTask[];
  taskStates: Record<string, DouyinTaskState>;
  favoriteUrlOptions: string[];
  collectListUrlOptions: string[];
  requestUrlFilterOptions: string[];
  douyinTaskStatusMap: Record<string, string>;
  douyinTaskEvents: Record<string, DouyinEvent[]>;
  updateDouyinTask: (taskId: string, patch: Partial<DouyinTask>) => void;
  removeDouyinTask: (taskId: string) => void;
  onStartTask: (task: DouyinTask) => void;
  onStopTask: (task: DouyinTask) => void;
  onRefreshTask: (task: DouyinTask) => void;
  onSetTaskHidden: (task: DouyinTask, hidden: boolean) => void;
  onLoginTask: (partitionId: string) => void;
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
    partitions,
    onAddPartition,
    onRemovePartition,
    onLoginPartition,
    onAddTask,
    onStartAll,
    onStopAll,
    douyinTasks,
    taskStates,
    favoriteUrlOptions,
    collectListUrlOptions,
    requestUrlFilterOptions,
    douyinTaskStatusMap,
    douyinTaskEvents,
    updateDouyinTask,
    removeDouyinTask,
    onStartTask,
    onStopTask,
    onRefreshTask,
    onSetTaskHidden,
    onLoginTask,
    deleteHistoryValue,
    setFavoriteUrlHistory,
    setCollectListUrlHistory,
    setRequestUrlFilterHistory
  } = props;
  const stateList = Object.values(taskStates);
  const runningCount = stateList.filter((state) => state.running).length;
  return (
    <Card title="抖音收藏监听">
      <Paragraph type="secondary">
        登录态按 partition 保存在本机 Electron 持久会话中。每个任务各自绑定一个 partition、各自配置定时器/显隐/停止策略并独立开关；下面的「新任务默认值」用于新增任务时的初始值。
      </Paragraph>

      <PartitionManagerCard
        partitions={partitions}
        onAdd={onAddPartition}
        onRemove={onRemovePartition}
        onLogin={onLoginPartition}
      />

      <Card className="douyin-defaults-card" title="新任务默认值">
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
          <Form.Item label="执行方式默认值">
            <Space direction="vertical" align="start">
              <Space>
                <Switch checked={douyinRunHidden} onChange={setDouyinRunHidden} />
                <Text type="secondary">{douyinRunHidden ? '默认隐藏 Douyin 窗口后台执行' : '默认显示 Douyin 窗口前台执行'}</Text>
              </Space>
              <Space>
                <Switch checked={douyinShowOnClickFailure} onChange={setDouyinShowOnClickFailure} />
                <Text type="secondary">默认点击失败立即弹到前台</Text>
              </Space>
            </Space>
          </Form.Item>
        </Form>
      </Card>

      <Space className="douyin-global-actions">
        <Button onClick={onAddTask}>新增任务</Button>
        <Button type="primary" onClick={onStartAll}>开始全部</Button>
        <Button onClick={onStopAll}>停止全部</Button>
      </Space>

      <Alert
        className="douyin-status"
        type="info"
        content={(
          <Space direction="vertical" size={2}>
            <Text>{douyinStatus}</Text>
            <Text>活跃 runner：{runningCount} / {douyinTasks.length}</Text>
          </Space>
        )}
      />

      <Space direction="vertical" className="douyin-task-list">
        {douyinTasks.map((task, index) => (
          <DouyinTaskCard
            key={task.id}
            task={task}
            index={index}
            partitions={partitions}
            taskState={taskStates[task.id]}
            favoriteUrlOptions={favoriteUrlOptions}
            collectListUrlOptions={collectListUrlOptions}
            requestUrlFilterOptions={requestUrlFilterOptions}
            events={douyinTaskEvents[task.id] || []}
            statusText={douyinTaskStatusMap[task.id] || '未开始'}
            updateDouyinTask={updateDouyinTask}
            removeDouyinTask={removeDouyinTask}
            onStartTask={onStartTask}
            onStopTask={onStopTask}
            onRefreshTask={onRefreshTask}
            onSetTaskHidden={onSetTaskHidden}
            onLoginTask={onLoginTask}
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
