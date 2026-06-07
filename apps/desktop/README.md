# @dogebot/desktop

`@dogebot/desktop` 是 DogeBot 的 Electron 桌面客户端。它连接 `@dogebot/server`，用于登录服务端并管理当前用户绑定的飞书机器人。

## 主要能力

- 填写服务端 URL、用户名、密码登录。
- 保存服务端 URL 和登录 token 到本地 `localStorage`。
- 查询当前用户绑定的飞书 bot。
- 展示每个 bot 的服务端长连接状态。
- 手动创建新的飞书 bot 绑定。
- 通过扫码创建新的飞书机器人并自动绑定。
- 探测 bot 凭证是否有效。
- 删除当前用户的 bot 绑定。
- 展示每个 bot 的 webhook 兜底地址。

## 目录结构

```text
apps/desktop/
├── src/
│   ├── index.html  # 页面结构和样式
│   ├── main.ts     # Electron 主进程入口
│   ├── renderer.tsx # React 页面交互和服务端 API 调用
│   └── style.css   # 前端样式
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml # 仅用于 pnpm 11 allowBuilds，不连接 server
├── vite.config.ts
└── tsconfig.json
```

## 开发命令

```bash
pnpm install
pnpm dev
```

安装依赖并启动 Electron 客户端。

```bash
pnpm build
```

编译 Electron 主进程，并通过 Vite 将 React 前端打包为 `dist/index.html` 和 `dist/assets/*`。

## 使用方式

先启动服务端：

```bash
cd ../server
pnpm dev
```

再启动桌面客户端：

```bash
cd ../desktop
pnpm dev
```

客户端启动后填写：

- 服务端 URL：默认 `http://127.0.0.1:3000`。
- 用户名：通过服务端 `pnpm add-user` 创建。
- 密码：创建用户时设置的密码。

登录成功后，可以在页面中绑定飞书 bot。

## 扫码创建飞书 bot

推荐使用“扫码创建并绑定”：

- 选择 `feishu` 或 `lark` 域名。
- 点击“扫码创建并绑定”。
- 客户端展示扫码链接并自动轮询授权结果。
- 授权成功后，服务端会自动保存新 bot，并启动对应长连接。
- 如果授权后长连接正常但收不到消息，需要到飞书开放平台确认模板是否已经完成机器人能力、长连接事件订阅、消息事件和权限发布。

## 手动绑定飞书 bot

创建 bot 绑定时需要填写：

- 名称：本地展示名称。
- 域名：`feishu` 或 `lark`。
- App ID：飞书开放平台应用的 App ID。
- App Secret：飞书开放平台应用的 App Secret。
- Verification Token：可选，用于 webhook 校验。
- Encrypt Key：可选，预留给加密事件。

绑定成功后，服务端会为该 bot 启动独立飞书 WebSocket 长连接。

手动绑定已有应用前，请先在飞书开放平台完成配置：

- 开启机器人能力。
- 开通接收单聊消息、接收群聊中 @ 机器人消息、以机器人身份发消息等权限。
- 在事件订阅中选择长连接模式。
- 添加 `im.message.receive_v1` 事件。
- 发布应用版本。

## 注意事项

- 客户端只负责管理绑定，不直接连接飞书。
- 所有飞书事件处理都在服务端完成。
- 删除 bot 绑定后，服务端会关闭对应 bot 的长连接。
- 当前 UI 是最小实现，后续可以继续拆分组件、增加状态提示和错误详情。
