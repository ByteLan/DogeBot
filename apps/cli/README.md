# @dogebot/cli

`@dogebot/cli` 是 DogeBot 的远程命令客户端。它会向 server 注册一个或多个 slash 命令，默认是 `/cr`；当飞书 bot 收到对应命令时，server 会把消息文本通过长连接转发给 CLI，CLI 将原始文本打印到 stdout。

## 开发命令

```bash
pnpm dev -- --username admin --password change-me
```

默认连接 `http://127.0.0.1:3000` 并注册 `/cr`。

```bash
pnpm dev -- --token '<登录 token>' --server http://127.0.0.1:3000 --command /cr
```

使用已有 Bearer token 注册命令。

```bash
pnpm build
pnpm start -- --username admin --password change-me --command /cr
```

运行编译后的 CLI。

## 参数

- `--server` / `-s`：DogeBot server 地址，默认 `http://127.0.0.1:3000`。
- `--command` / `-c`：要注册的命令，可重复或用逗号分隔；不传时默认 `/cr`。
- `--token`：直接使用 `/api/login` 返回的 Bearer token。
- `--username` / `--password`：未提供 token 时自动登录。
- `--client`：客户端名称，展示在 server 的注册列表里。
- `--json`：打印完整转发 payload；默认只打印原始消息文本。

## 环境变量

- `DOGEBOT_SERVER_URL`
- `DOGEBOT_REMOTE_COMMANDS` 或 `DOGEBOT_REMOTE_COMMAND`
- `DOGEBOT_TOKEN`
- `DOGEBOT_USERNAME`
- `DOGEBOT_PASSWORD`
- `DOGEBOT_CLIENT_NAME`

## 重连行为

CLI 通过 `GET /api/remote-commands/connect` 建立 SSE 长连接。连接断开后，server 会自动取消内存注册；CLI 会按指数退避重连，重连成功后重新注册命令。
