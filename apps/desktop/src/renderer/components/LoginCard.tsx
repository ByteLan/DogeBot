import React, { type Dispatch, type SetStateAction } from 'react';
import { Button, Card, Form, Grid, Input } from '@arco-design/web-react';
import type { LoginForm } from '../types';

const { Row, Col } = Grid;

export function LoginCard(props: {
  serverUrl: string;
  setServerUrl: Dispatch<SetStateAction<string>>;
  loginForm: LoginForm;
  setLoginForm: Dispatch<SetStateAction<LoginForm>>;
  onLogin: () => void;
}) {
  const { serverUrl, setServerUrl, loginForm, setLoginForm, onLogin } = props;
  return (
    <Card title="登录服务端">
      <Form layout="vertical">
        <Form.Item label="服务端 URL">
          <Input value={serverUrl} onChange={setServerUrl} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="用户名">
              <Input value={loginForm.username} autoComplete="username" onChange={(username) => setLoginForm((form) => ({ ...form, username }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="密码">
              <Input.Password value={loginForm.password} autoComplete="current-password" onChange={(password) => setLoginForm((form) => ({ ...form, password }))} />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" onClick={onLogin}>登录</Button>
      </Form>
    </Card>
  );
}
