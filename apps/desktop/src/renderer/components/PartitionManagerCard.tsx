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
    <Card className="douyin-partition-card" title="浏览器身份管理">
      <Typography.Paragraph type="secondary">
        每个浏览器身份（partition）保存一份独立登录态；使用同一身份的任务会共享登录。
      </Typography.Paragraph>
      <Space className="partition-create-row">
        <Input
          aria-label="新浏览器身份名称"
          value={name}
          placeholder="输入新身份名称"
          onChange={setName}
          onPressEnter={submit}
        />
        <Button onClick={submit}>新增身份</Button>
      </Space>
      <List
        className="douyin-partition-list"
        dataSource={partitions}
        noDataElement={<Text type="secondary">暂无</Text>}
        render={(partition) => (
          <List.Item
            key={partition.id}
            actions={[
              <Button key="login" size="small" onClick={() => onLogin(partition.id)}>登录抖音</Button>,
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
