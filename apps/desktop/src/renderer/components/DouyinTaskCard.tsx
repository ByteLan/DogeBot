import React, { type Dispatch, type SetStateAction } from 'react';
import { Button, Card, Form, Grid, Input, InputNumber, Select, Space, Switch, Tabs, Typography } from '@arco-design/web-react';
import { JsonView, allExpanded, collapseAllNested, darkStyles } from 'react-json-view-lite';
import { extractAwemeIds } from '../../shared/aweme';
import { defaultRequestUrlFilter } from '../../shared/constants';
import type { DouyinEvent, DouyinPartition, DouyinTask, DouyinTaskState } from '../types';
import { HistorySelect } from './HistorySelect';

const { Title, Text, Paragraph } = Typography;
const { Row, Col } = Grid;

function TaskStateLine(props: { taskState?: DouyinTaskState }) {
  const { taskState } = props;
  if (!taskState) return <Text type="secondary">运行状态：未运行</Text>;
  const runState = taskState.tickRunning ? '刷新中' : taskState.running ? '等待下次刷新' : '未运行';
  return (
    <Text type="secondary">
      当前间隔：{taskState.currentIntervalSeconds}s（{taskState.mode === 'short' ? '短间隔' : '长间隔'}）；
      retry：{taskState.sameIdsCount}/{taskState.retryLimit}；
      状态：{runState}；
      窗口：{taskState.windowOpen ? (taskState.hidden ? '后台隐藏' : '前台显示') : '未打开'}
      {taskState.nextRunAt ? `；下次刷新：${new Date(taskState.nextRunAt).toLocaleString()}` : ''}
    </Text>
  );
}

export function DouyinTaskCard(props: {
  task: DouyinTask;
  index: number;
  partitions: DouyinPartition[];
  taskState?: DouyinTaskState;
  favoriteUrlOptions: string[];
  collectListUrlOptions: string[];
  requestUrlFilterOptions: string[];
  events: DouyinEvent[];
  statusText: string;
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
    task,
    index,
    partitions,
    taskState,
    favoriteUrlOptions,
    collectListUrlOptions,
    requestUrlFilterOptions,
    events: taskEvents,
    statusText,
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
  const running = Boolean(taskState?.running);
  const tickRunning = Boolean(taskState?.tickRunning);
  return (
    <Card
      className="douyin-task-card"
      title={`任务 ${index + 1}`}
      extra={(
        <Space>
          <Switch checked={task.enabled} onChange={(enabled) => updateDouyinTask(task.id, { enabled })} />
          <Text type="secondary">{task.enabled ? '活跃' : '停用'}</Text>
          <Button size="mini" status="danger" onClick={() => removeDouyinTask(task.id)}>删除</Button>
        </Space>
      )}
    >
      <Form layout="vertical">
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="favoriteUrl">
              <HistorySelect
                value={task.favoriteUrl}
                placeholder="请输入或选择历史 favoriteUrl"
                options={favoriteUrlOptions}
                onChange={(value) => updateDouyinTask(task.id, { favoriteUrl: String(value || '') })}
                onDeleteHistory={() => deleteHistoryValue(task.favoriteUrl, setFavoriteUrlHistory)}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="collectListUrl">
              <HistorySelect
                value={task.collectListUrl}
                placeholder="请输入或选择历史 collectListUrl"
                options={collectListUrlOptions}
                onChange={(value) => updateDouyinTask(task.id, { collectListUrl: String(value || '') })}
                onDeleteHistory={() => deleteHistoryValue(task.collectListUrl, setCollectListUrlHistory)}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="请求 URL 筛选字符串">
              <HistorySelect
                value={task.requestUrlFilter}
                placeholder="请输入或选择历史请求 URL 筛选字符串"
                options={requestUrlFilterOptions}
                onChange={(value) => updateDouyinTask(task.id, { requestUrlFilter: String(value || defaultRequestUrlFilter) })}
                onDeleteHistory={() => deleteHistoryValue(task.requestUrlFilter, setRequestUrlFilterHistory)}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="clickText">
              <Input value={task.clickText} onChange={(value) => updateDouyinTask(task.id, { clickText: value })} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={6}>
            <Form.Item label="partition">
              <Select value={task.partitionId} onChange={(value) => updateDouyinTask(task.id, { partitionId: String(value) })}>
                {partitions.map((partition) => (
                  <Select.Option key={partition.id} value={partition.id}>
                    {partition.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="短间隔（秒）">
              <InputNumber min={1} precision={0} value={task.shortIntervalSeconds} onChange={(value) => updateDouyinTask(task.id, { shortIntervalSeconds: Number(value) > 0 ? Number(value) : 10 })} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="长间隔（秒）">
              <InputNumber min={1} precision={0} value={task.longIntervalSeconds} onChange={(value) => updateDouyinTask(task.id, { longIntervalSeconds: Number(value) > 0 ? Number(value) : 60 })} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="retry 次数">
              <InputNumber min={1} precision={0} value={task.retryLimit} onChange={(value) => updateDouyinTask(task.id, { retryLimit: Number(value) > 0 ? Number(value) : 3 })} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item label="执行 / 窗口">
          <Space direction="vertical" align="start">
            <Space>
              <Switch checked={task.skipClick} onChange={(skipClick) => updateDouyinTask(task.id, { skipClick })} />
              <Text type="secondary">{task.skipClick ? '不点击，仅刷新页面并监听 API' : '刷新页面后点击 clickText'}</Text>
            </Space>
            <Space>
              <Switch checked={task.runHidden} onChange={(hidden) => onSetTaskHidden(task, hidden)} />
              <Text type="secondary">{task.runHidden ? '隐藏窗口后台执行' : '显示窗口前台执行'}</Text>
            </Space>
            <Space>
              <Switch checked={task.showOnClickFailure} onChange={(showOnClickFailure) => updateDouyinTask(task.id, { showOnClickFailure })} />
              <Text type="secondary">点击失败立即弹到前台</Text>
            </Space>
            <Space>
              <Switch checked={task.destroyOnStop} onChange={(destroyOnStop) => updateDouyinTask(task.id, { destroyOnStop })} />
              <Text type="secondary">{task.destroyOnStop ? '停止时销毁窗口释放内存' : '停止时保留窗口（可再显隐）'}</Text>
            </Space>
          </Space>
        </Form.Item>
        <Space>
          <Button size="small" onClick={() => onLoginTask(task.partitionId)}>登录</Button>
          <Button size="small" type="primary" onClick={() => onStartTask(task)}>开始监听</Button>
          <Button size="small" onClick={() => onRefreshTask(task)} disabled={!running || tickRunning}>立即刷新</Button>
          <Button size="small" onClick={() => onStopTask(task)}>停止监听</Button>
        </Space>
      </Form>
      <Paragraph className="douyin-task-status" type="secondary">
        当前状态：{statusText}
      </Paragraph>
      <TaskStateLine taskState={taskState} />
      <Title heading={6}>接口返回</Title>
      {taskEvents.length === 0 ? (
        <div className="json-empty">暂无</div>
      ) : (
        <Space direction="vertical" className="json-list">
          {taskEvents.map((event) => (
            <Card key={event.id} className="json-card" title={`${new Date(Number(event.id.split('-')[0])).toLocaleString()} · ${event.title}`}>
              <Tabs defaultActiveTab="awemeIds">
                <Tabs.TabPane key="awemeIds" title="aweme_id">
                  <JsonView data={extractAwemeIds(event.data)} shouldExpandNode={allExpanded} style={darkStyles} />
                </Tabs.TabPane>
                <Tabs.TabPane key="body" title="Body">
                  <JsonView data={event.data as object} shouldExpandNode={collapseAllNested} style={darkStyles} />
                </Tabs.TabPane>
              </Tabs>
            </Card>
          ))}
        </Space>
      )}
    </Card>
  );
}
