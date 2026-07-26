import React, { type Dispatch, type SetStateAction } from 'react';
import { Button, Card, Form, Grid, Input, Space, Switch, Tabs, Typography } from '@arco-design/web-react';
import { JsonView, allExpanded, collapseAllNested, darkStyles } from 'react-json-view-lite';
import { extractAwemeIds } from '../../shared/aweme';
import { defaultRequestUrlFilter } from '../../shared/constants';
import type { DouyinEvent, DouyinTask } from '../types';
import { HistorySelect } from './HistorySelect';

const { Title, Text, Paragraph } = Typography;
const { Row, Col } = Grid;

export function DouyinTaskCard(props: {
  task: DouyinTask;
  index: number;
  favoriteUrlOptions: string[];
  collectListUrlOptions: string[];
  requestUrlFilterOptions: string[];
  events: DouyinEvent[];
  statusText: string;
  updateDouyinTask: (taskId: string, patch: Partial<DouyinTask>) => void;
  removeDouyinTask: (taskId: string) => void;
  deleteHistoryValue: (currentValue: string, setHistory: Dispatch<SetStateAction<string[]>>) => void;
  setFavoriteUrlHistory: Dispatch<SetStateAction<string[]>>;
  setCollectListUrlHistory: Dispatch<SetStateAction<string[]>>;
  setRequestUrlFilterHistory: Dispatch<SetStateAction<string[]>>;
}) {
  const {
    task,
    index,
    favoriteUrlOptions,
    collectListUrlOptions,
    requestUrlFilterOptions,
    events: taskEvents,
    statusText,
    updateDouyinTask,
    removeDouyinTask,
    deleteHistoryValue,
    setFavoriteUrlHistory,
    setCollectListUrlHistory,
    setRequestUrlFilterHistory
  } = props;
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
        <Form.Item label="执行动作">
          <Space>
            <Switch checked={task.skipClick} onChange={(skipClick) => updateDouyinTask(task.id, { skipClick })} />
            <Text type="secondary">{task.skipClick ? '不点击，仅刷新页面并监听 API' : '刷新页面后点击 clickText'}</Text>
          </Space>
        </Form.Item>
      </Form>
      <Paragraph className="douyin-task-status" type="secondary">
        当前状态：{statusText}
      </Paragraph>
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
