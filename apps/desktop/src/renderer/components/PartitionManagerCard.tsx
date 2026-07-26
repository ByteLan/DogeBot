import React, { useState } from 'react';
import { Button, Card, Input, List, Space, Typography } from '@arco-design/web-react';
import { DEFAULT_PARTITION_ID, partitionElectronId } from '../storage';
import type { DouyinPartition } from '../types';

const { Text } = Typography;

export function PartitionManagerCard(props: {
  partitions: DouyinPartition[];
  onAdd: (name: string) => void;
  onRemove: (partitionId: string) => void;
  onLogin: (partitionId: string) => void;
}) {
  const { partitions, onAdd, onRemove, onLogin } = props;
  const [name, setName] = useState('');
  const submit = () => {
    if (!name.trim()) return;
    onAdd(name);
    setName('');
  };
  return (
    <Card className="douyin-partition-card" title="浏览器 partition 管理">
      <Typography.Paragraph type="secondary">
        每个 partition 是一份独立的登录态；共享同一 partition 的任务共享登录，各任务仍会打开各自的窗口。
      </Typography.Paragraph>
      <Space>
        <Input
          style={{ width: 240 }}
          value={name}
          placeholder="新 partition 名称"
          onChange={setName}
          onPressEnter={submit}
        />
        <Button type="primary" onClick={submit}>新增 partition</Button>
      </Space>
      <List
        className="douyin-partition-list"
        dataSource={partitions}
        noDataElement={<Text type="secondary">暂无</Text>}
        render={(partition) => (
          <List.Item
            key={partition.id}
            actions={[
              <Button key="login" size="small" onClick={() => onLogin(partition.id)}>登录</Button>,
              <Button
                key="remove"
                size="small"
                status="danger"
                disabled={partition.id === DEFAULT_PARTITION_ID}
                onClick={() => onRemove(partition.id)}
              >
                删除
              </Button>
            ]}
          >
            <List.Item.Meta
              title={partition.name}
              description={<Text type="secondary"><code>{partitionElectronId(partition.id)}</code></Text>}
            />
          </List.Item>
        )}
      />
    </Card>
  );
}
