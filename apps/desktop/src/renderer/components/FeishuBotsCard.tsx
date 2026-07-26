import React, { type Dispatch, type SetStateAction } from 'react';
import { Alert, Button, Card, Collapse, Form, Grid, Input, Link, List, Select, Space, Typography } from '@arco-design/web-react';
import type { Bot, BotForm, Connection, QrBegin } from '../types';

const { Title, Text, Paragraph } = Typography;
const { Row, Col } = Grid;

export function FeishuBotsCard(props: {
  botForm: BotForm;
  setBotForm: Dispatch<SetStateAction<BotForm>>;
  onCreateBot: () => void;
  onBeginQrRegistration: () => void;
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
    qrRegistration,
    bots,
    connectionMap,
    apiUrl,
    onProbe,
    onDelete
  } = props;
  return (
    <Card title="飞书机器人">
      <Paragraph type="secondary">优先使用扫码快速创建并绑定；已有飞书应用也可以通过下方手动绑定。</Paragraph>

      <div className="feishu-quick-bind">
        <div className="quick-bind-copy">
          <Text className="section-kicker">推荐方式</Text>
          <Text className="quick-bind-title">扫码创建并绑定机器人</Text>
          <Text type="secondary">选择应用区域后，在飞书中完成授权即可。</Text>
        </div>
        <Space className="quick-bind-actions">
          <Select
            className="domain-select"
            aria-label="应用区域"
            value={botForm.domain}
            onChange={(domain) => setBotForm((form) => ({ ...form, domain }))}
          >
            <Select.Option value="feishu">飞书（中国）</Select.Option>
            <Select.Option value="lark">Lark（国际）</Select.Option>
          </Select>
          <Button type="primary" onClick={onBeginQrRegistration}>扫码创建并绑定</Button>
        </Space>
      </div>

      {qrRegistration ? (
        <Alert
          className="qr-box"
          type="info"
          content={<span>请在飞书中打开下面链接并扫码授权：<Link href={qrRegistration.qrUrl} target="_blank">{qrRegistration.qrUrl}</Link></span>}
        />
      ) : null}

      <Collapse className="ui-collapse manual-bind-collapse" bordered={false}>
        <Collapse.Item name="manual-bind" header="手动绑定已有应用">
          <Form layout="vertical">
            <Row gutter={12}>
              <Col xs={24} sm={12}>
                <Form.Item label="机器人名称">
                  <Input aria-label="机器人名称" value={botForm.name} placeholder="Doge Echo Bot" onChange={(name) => setBotForm((form) => ({ ...form, name }))} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item label="App ID">
                  <Input aria-label="App ID" value={botForm.appId} onChange={(appId) => setBotForm((form) => ({ ...form, appId }))} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label="App Secret">
              <Input.Password aria-label="App Secret" value={botForm.appSecret} onChange={(appSecret) => setBotForm((form) => ({ ...form, appSecret }))} />
            </Form.Item>
            <Row gutter={12}>
              <Col xs={24} sm={12}>
                <Form.Item label="Verification Token（可选）">
                  <Input aria-label="Verification Token" value={botForm.verificationToken} onChange={(verificationToken) => setBotForm((form) => ({ ...form, verificationToken }))} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item label="Encrypt Key（可选）">
                  <Input aria-label="Encrypt Key" value={botForm.encryptKey} onChange={(encryptKey) => setBotForm((form) => ({ ...form, encryptKey }))} />
                </Form.Item>
              </Col>
            </Row>
            <Button onClick={onCreateBot}>手动绑定机器人</Button>
          </Form>
        </Collapse.Item>
      </Collapse>

      <div className="section-heading">
        <div>
          <Title heading={5}>已绑定机器人</Title>
          <Text type="secondary">共 {bots.length} 个</Text>
        </div>
      </div>
      <List
        dataSource={bots}
        noDataElement={<div className="compact-empty">暂未绑定机器人</div>}
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
