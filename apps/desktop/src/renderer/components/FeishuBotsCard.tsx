import React, { type Dispatch, type SetStateAction } from 'react';
import { Alert, Button, Card, Form, Grid, Input, Link, List, Select, Space, Typography } from '@arco-design/web-react';
import type { Bot, BotForm, Connection, QrBegin } from '../types';

const { Title, Text, Paragraph } = Typography;
const { Row, Col } = Grid;

export function FeishuBotsCard(props: {
  botForm: BotForm;
  setBotForm: Dispatch<SetStateAction<BotForm>>;
  onCreateBot: () => void;
  onBeginQrRegistration: () => void;
  onLogout: () => void;
  qrRegistration: QrBegin | undefined;
  bots: Bot[];
  connectionMap: Map<number, Connection>;
  apiUrl: (path: string) => string;
  onProbe: (bot: Bot) => void | Promise<void>;
  onDelete: (bot: Bot) => void | Promise<void>;
}) {
  const {
    botForm,
    setBotForm,
    onCreateBot,
    onBeginQrRegistration,
    onLogout,
    qrRegistration,
    bots,
    connectionMap,
    apiUrl,
    onProbe,
    onDelete
  } = props;
  return (
    <Card title="飞书机器人绑定">
      <Paragraph type="secondary">绑定后，在飞书开放平台配置事件回调地址为对应 webhook URL。当前机器人会把用户发来的文本原样回复。</Paragraph>
      <Form layout="vertical">
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="名称">
              <Input value={botForm.name} placeholder="Doge Echo Bot" onChange={(name) => setBotForm((form) => ({ ...form, name }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="域名">
              <Select value={botForm.domain} onChange={(domain) => setBotForm((form) => ({ ...form, domain }))}>
                <Select.Option value="feishu">feishu</Select.Option>
                <Select.Option value="lark">lark</Select.Option>
              </Select>
            </Form.Item>
          </Col>
        </Row>
        <Form.Item label="App ID">
          <Input value={botForm.appId} onChange={(appId) => setBotForm((form) => ({ ...form, appId }))} />
        </Form.Item>
        <Form.Item label="App Secret">
          <Input.Password value={botForm.appSecret} onChange={(appSecret) => setBotForm((form) => ({ ...form, appSecret }))} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="Verification Token">
              <Input value={botForm.verificationToken} onChange={(verificationToken) => setBotForm((form) => ({ ...form, verificationToken }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="Encrypt Key">
              <Input value={botForm.encryptKey} onChange={(encryptKey) => setBotForm((form) => ({ ...form, encryptKey }))} />
            </Form.Item>
          </Col>
        </Row>
        <Space>
          <Button type="primary" onClick={onCreateBot}>绑定机器人</Button>
          <Button onClick={onBeginQrRegistration}>扫码创建并绑定</Button>
          <Button onClick={onLogout}>退出登录</Button>
        </Space>
      </Form>
      {qrRegistration ? (
        <Alert
          className="qr-box"
          type="info"
          content={<span>请在飞书中打开下面链接并扫码授权：<Link href={qrRegistration.qrUrl} target="_blank">{qrRegistration.qrUrl}</Link></span>}
        />
      ) : null}
      <Title heading={5}>已绑定</Title>
      <List
        dataSource={bots}
        noDataElement={<Text type="secondary">暂无</Text>}
        render={(bot) => {
          const connection = connectionMap.get(bot.id);
          const status = connection ? connection.status : '未连接';
          const error = connection?.error ? ` · ${connection.error}` : '';
          return (
            <List.Item
              actions={[
                <Button key="probe" size="small" onClick={() => void onProbe(bot)}>探测</Button>,
                <Button key="delete" size="small" status="danger" onClick={() => void onDelete(bot)}>删除</Button>
              ]}
            >
              <List.Item.Meta
                title={bot.name}
                description={(
                  <Space direction="vertical" size={2}>
                    <Text type="secondary">{bot.botName || '未探测'} · {bot.domain}</Text>
                    <Text>长连接: {status}{error}</Text>
                    <Text>Webhook: <code>{apiUrl(bot.webhookPath)}</code></Text>
                  </Space>
                )}
              />
            </List.Item>
          );
        }}
      />
    </Card>
  );
}
