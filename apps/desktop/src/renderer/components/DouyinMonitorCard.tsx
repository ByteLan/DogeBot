import React, { type Dispatch, type SetStateAction } from 'react';
import { Alert, Button, Card, Collapse, Form, Grid, InputNumber, Space, Switch, Typography } from '@arco-design/web-react';
import type { DouyinEvent, DouyinPartition, DouyinTask, DouyinTaskState } from '../types';
import { DouyinTaskCard } from './DouyinTaskCard';
import { PartitionManagerCard } from './PartitionManagerCard';

const { Title, Text, Paragraph } = Typography;
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
  const statusType = /未加载|失败|错误/.test(douyinStatus) ? 'warning' : runningCount > 0 ? 'success' : 'info';
  return (
    <Card title="抖音收藏监听">
      <Paragraph type="secondary">
        管理收藏监听任务与浏览器登录状态。每个任务拥有独立配置和运行开关。
      </Paragraph>

      <div className="monitor-command-bar">
        <Space className="douyin-global-actions">
          <Button onClick={onAddTask}>新增任务</Button>
          <Button type="primary" onClick={onStartAll}>开始全部</Button>
          <Button onClick={onStopAll}>停止全部</Button>
        </Space>
        <div className={`runner-summary ${runningCount > 0 ? 'is-running' : ''}`}>
          <span className="runner-dot" />
          <Text>{runningCount > 0 ? `${runningCount} 个任务运行中` : '当前没有运行中的任务'}</Text>
        </div>
      </div>

      <Alert
        className="douyin-status"
        type={statusType}
        content={(
          <div className="status-content">
            <Text>{douyinStatus}</Text>
            <Text type="secondary">活跃任务 {runningCount} / {douyinTasks.length}</Text>
          </div>
        )}
      />

      <Collapse className="ui-collapse settings-collapse" bordered={false}>
        <Collapse.Item
          name="settings"
          header={(
            <div className="collapse-heading">
              <Text>运行设置</Text>
              <Text type="secondary">浏览器身份与新任务默认值</Text>
            </div>
          )}
        >
          <PartitionManagerCard
            partitions={partitions}
            onAdd={onAddPartition}
            onRemove={onRemovePartition}
            onLogin={onLoginPartition}
          />

          <Card className="douyin-defaults-card" title="新任务默认值">
            <Text className="settings-note" type="secondary">以下设置仅在新增任务时作为初始值，不会修改已有任务。</Text>
            <Form layout="vertical">
              <Row gutter={12}>
                <Col xs={24} sm={8}>
                  <Form.Item label="短间隔（秒）">
                    <InputNumber aria-label="默认短间隔秒数" min={1} precision={0} value={douyinShortIntervalSeconds} onChange={(value) => setDouyinShortIntervalSeconds(Number(value) > 0 ? Number(value) : 10)} />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={8}>
                  <Form.Item label="长间隔（秒）">
                    <InputNumber aria-label="默认长间隔秒数" min={1} precision={0} value={douyinLongIntervalSeconds} onChange={(value) => setDouyinLongIntervalSeconds(Number(value) > 0 ? Number(value) : 60)} />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={8}>
                  <Form.Item label="重试次数">
                    <InputNumber aria-label="默认重试次数" min={1} precision={0} value={douyinRetryLimit} onChange={(value) => setDouyinRetryLimit(Number(value) > 0 ? Number(value) : 3)} />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label="新任务执行方式">
                <div className="option-grid option-grid-compact">
                  <div className="option-row">
                    <Switch aria-label="新任务默认后台隐藏窗口" checked={douyinRunHidden} onChange={setDouyinRunHidden} />
                    <div>
                      <Text>后台隐藏窗口</Text>
                      <Text type="secondary">新任务默认在后台执行</Text>
                    </div>
                  </div>
                  <div className="option-row">
                    <Switch aria-label="新任务默认点击失败时显示窗口" checked={douyinShowOnClickFailure} onChange={setDouyinShowOnClickFailure} />
                    <div>
                      <Text>点击失败时显示窗口</Text>
                      <Text type="secondary">便于立即检查页面状态</Text>
                    </div>
                  </div>
                </div>
              </Form.Item>
            </Form>
          </Card>
        </Collapse.Item>
      </Collapse>

      <div className="section-heading task-section-heading">
        <div>
          <Title heading={5}>监听任务</Title>
          <Text type="secondary">{douyinTasks.length} 个任务，{douyinTasks.filter((task) => task.enabled).length} 个已启用</Text>
        </div>
      </div>

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
