import React, { type Dispatch, type SetStateAction } from 'react';
import { Button, Card, Collapse, Form, Grid, Input, InputNumber, Select, Space, Switch, Tabs, Typography } from '@arco-design/web-react';
import { JsonView, allExpanded, collapseAllNested, defaultStyles } from 'react-json-view-lite';
import { extractAwemeIds } from '../../shared/aweme';
import { defaultRequestUrlFilter } from '../../shared/constants';
import type { DouyinEvent, DouyinPartition, DouyinTask, DouyinTaskState } from '../types';
import { HistorySelect } from './HistorySelect';

const { Text } = Typography;
const { Row, Col } = Grid;

function TaskStateLine(props: { taskState?: DouyinTaskState }) {
  const { taskState } = props;
  if (!taskState) {
    return (
      <div className="task-runtime-meta">
        <span><Text type="secondary">运行状态</Text><Text>未运行</Text></span>
      </div>
    );
  }
  const runState = taskState.tickRunning ? '刷新中' : taskState.running ? '等待下次刷新' : '未运行';
  return (
    <div className="task-runtime-meta">
      <span><Text type="secondary">运行状态</Text><Text>{runState}</Text></span>
      <span><Text type="secondary">当前间隔</Text><Text>{taskState.currentIntervalSeconds}s · {taskState.mode === 'short' ? '短间隔' : '长间隔'}</Text></span>
      <span><Text type="secondary">重试</Text><Text>{taskState.sameIdsCount} / {taskState.retryLimit}</Text></span>
      <span><Text type="secondary">窗口</Text><Text>{taskState.windowOpen ? (taskState.hidden ? '后台隐藏' : '前台显示') : '未打开'}</Text></span>
      {taskState.nextRunAt ? <span><Text type="secondary">下次刷新</Text><Text>{new Date(taskState.nextRunAt).toLocaleString()}</Text></span> : null}
    </div>
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
          <Switch aria-label={`任务 ${index + 1} 是否启用`} checked={task.enabled} onChange={(enabled) => updateDouyinTask(task.id, { enabled })} />
          <span className={`task-enabled-label ${task.enabled ? 'is-enabled' : ''}`}>{task.enabled ? '已启用' : '已停用'}</span>
          <Button size="mini" status="danger" onClick={() => removeDouyinTask(task.id)}>删除</Button>
        </Space>
      )}
    >
      <Form layout="vertical">
        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item label="收藏页地址（favoriteUrl）">
              <HistorySelect
                value={task.favoriteUrl}
                ariaLabel="收藏页地址"
                placeholder="请输入或选择历史收藏页地址"
                options={favoriteUrlOptions}
                onChange={(value) => updateDouyinTask(task.id, { favoriteUrl: String(value || '') })}
                onDeleteHistory={() => deleteHistoryValue(task.favoriteUrl, setFavoriteUrlHistory)}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label="接口地址（collectListUrl）">
              <HistorySelect
                value={task.collectListUrl}
                ariaLabel="接口地址"
                placeholder="请输入或选择历史接口地址"
                options={collectListUrlOptions}
                onChange={(value) => updateDouyinTask(task.id, { collectListUrl: String(value || '') })}
                onDeleteHistory={() => deleteHistoryValue(task.collectListUrl, setCollectListUrlHistory)}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item label="请求 URL 筛选字符串">
              <HistorySelect
                value={task.requestUrlFilter}
                ariaLabel="请求 URL 筛选字符串"
                placeholder="请输入或选择历史请求 URL 筛选字符串"
                options={requestUrlFilterOptions}
                onChange={(value) => updateDouyinTask(task.id, { requestUrlFilter: String(value || defaultRequestUrlFilter) })}
                onDeleteHistory={() => deleteHistoryValue(task.requestUrlFilter, setRequestUrlFilterHistory)}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label="模拟点击文案（clickText）">
              <Input aria-label="模拟点击文案" value={task.clickText} onChange={(value) => updateDouyinTask(task.id, { clickText: value })} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col xs={12} sm={6}>
            <Form.Item label="浏览器身份">
              <Select aria-label="浏览器身份" value={task.partitionId} onChange={(value) => updateDouyinTask(task.id, { partitionId: String(value) })}>
                {partitions.map((partition) => (
                  <Select.Option key={partition.id} value={partition.id}>
                    {partition.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
          <Col xs={12} sm={6}>
            <Form.Item label="短间隔（秒）">
              <InputNumber aria-label="短间隔秒数" min={1} precision={0} value={task.shortIntervalSeconds} onChange={(value) => updateDouyinTask(task.id, { shortIntervalSeconds: Number(value) > 0 ? Number(value) : 10 })} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6}>
            <Form.Item label="长间隔（秒）">
              <InputNumber aria-label="长间隔秒数" min={1} precision={0} value={task.longIntervalSeconds} onChange={(value) => updateDouyinTask(task.id, { longIntervalSeconds: Number(value) > 0 ? Number(value) : 60 })} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6}>
            <Form.Item label="重试次数">
              <InputNumber aria-label="重试次数" min={1} precision={0} value={task.retryLimit} onChange={(value) => updateDouyinTask(task.id, { retryLimit: Number(value) > 0 ? Number(value) : 3 })} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item label="执行与窗口">
          <div className="option-grid">
            <div className="option-row">
              <Switch aria-label="跳过模拟点击" checked={task.skipClick} onChange={(skipClick) => updateDouyinTask(task.id, { skipClick })} />
              <div><Text>跳过模拟点击</Text><Text type="secondary">仅刷新页面并监听 API</Text></div>
            </div>
            <div className="option-row">
              <Switch aria-label="后台隐藏窗口" checked={task.runHidden} onChange={(hidden) => onSetTaskHidden(task, hidden)} />
              <div><Text>后台隐藏窗口</Text><Text type="secondary">任务运行时不显示抖音窗口</Text></div>
            </div>
            <div className="option-row">
              <Switch aria-label="点击失败时显示窗口" checked={task.showOnClickFailure} onChange={(showOnClickFailure) => updateDouyinTask(task.id, { showOnClickFailure })} />
              <div><Text>点击失败时显示窗口</Text><Text type="secondary">便于立即检查页面状态</Text></div>
            </div>
            <div className="option-row">
              <Switch aria-label="停止时销毁窗口" checked={task.destroyOnStop} onChange={(destroyOnStop) => updateDouyinTask(task.id, { destroyOnStop })} />
              <div><Text>停止时销毁窗口</Text><Text type="secondary">释放窗口占用的内存</Text></div>
            </div>
          </div>
        </Form.Item>
        <Space className="task-actions">
          <Button size="small" onClick={() => onLoginTask(task.partitionId)}>登录</Button>
          <Button size="small" type="primary" onClick={() => onStartTask(task)}>开始监听</Button>
          <Button size="small" onClick={() => onRefreshTask(task)} disabled={!running || tickRunning}>立即刷新</Button>
          <Button size="small" onClick={() => onStopTask(task)}>停止监听</Button>
        </Space>
      </Form>

      <div className="task-status-panel">
        <div className="task-current-status"><span className={`status-dot ${running ? 'is-running' : ''}`} /><Text>当前状态：{statusText}</Text></div>
        <TaskStateLine taskState={taskState} />
      </div>

      <Collapse className="ui-collapse result-collapse" bordered={false} defaultActiveKey={taskEvents.length > 0 ? ['results'] : []}>
        <Collapse.Item name="results" header={`接口返回 · ${taskEvents.length} 条`}>
          {taskEvents.length === 0 ? (
            <div className="json-empty">任务运行并捕获接口后，结果会显示在这里</div>
          ) : (
            <Space direction="vertical" className="json-list">
              {taskEvents.map((event) => (
                <Card key={event.id} className="json-card" title={`${new Date(Number(event.id.split('-')[0])).toLocaleString()} · ${event.title}`}>
                  <Tabs defaultActiveTab="awemeIds">
                    <Tabs.TabPane key="awemeIds" title="aweme_id">
                      <JsonView data={extractAwemeIds(event.data)} shouldExpandNode={allExpanded} style={defaultStyles} />
                    </Tabs.TabPane>
                    <Tabs.TabPane key="body" title="Body">
                      <JsonView data={event.data as object} shouldExpandNode={collapseAllNested} style={defaultStyles} />
                    </Tabs.TabPane>
                  </Tabs>
                </Card>
              ))}
            </Space>
          )}
        </Collapse.Item>
      </Collapse>
    </Card>
  );
}
