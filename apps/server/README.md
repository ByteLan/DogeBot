# @dogebot/server

`@dogebot/server` 是 DogeBot 的 Node.js 服务端应用，负责用户认证、SQLite 数据存储、飞书机器人绑定，以及为每个已启用 bot 维护独立飞书 WebSocket 长连接。

## 主要能力

- 本地用户登录：通过用户名和密码登录，返回 Bearer token。
- 用户维度隔离：每个用户只能管理自己绑定的飞书 bot。
- 多 bot 支持：一个用户可以绑定多个飞书 bot。
- 扫码创建绑定：通过飞书 `/oauth/v1/app/registration` 注册流程创建新机器人，并自动绑定到当前用户。
- 飞书长连接：每个 bot 对应一个独立 `WSClient`，服务启动后自动恢复已有连接。
- `/users` 命令：记录某个 bot 下用户 at 过的人，并用飞书消息卡片返回历史列表。
- SQLite 存储：用户、bot 绑定、at 用户记录都持久化到本地 SQLite。

## 目录结构

```text
apps/server/
├── scripts/
│   └── add-user.ts        # 创建本地登录用户
├── src/
│   ├── auth.ts            # 密码哈希、登录鉴权、token 生成和校验
│   ├── db.ts              # SQLite 初始化和表结构
│   ├── feishu.ts          # 飞书 bot API、消息处理、/users 命令
│   ├── feishuConnection.ts # 飞书 WebSocket 长连接管理
│   ├── feishuOnboard.ts    # 飞书扫码创建机器人注册流程
│   └── index.ts           # Express 服务入口
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml  # 仅用于 pnpm 11 allowBuilds，不连接 desktop
└── tsconfig.json
```

## 开发命令

```bash
pnpm dev
```

以 watch 模式启动服务端。

```bash
pnpm build
```

执行 TypeScript 编译。

```bash
pnpm start
```

运行编译后的服务端。

```bash
pnpm add-user <用户名> <密码>
```

创建本地登录用户。请先在 `apps/server` 目录执行 `pnpm install`，之后直接运行该命令。

## 环境变量

- `PORT`：HTTP 服务端口，默认 `3000`。
- `DOGEBOT_DATA_DIR`：SQLite 数据目录，默认 `apps/server/data`。
- `DOGEBOT_AUTH_SECRET`：登录 token 签名密钥；开发环境有默认值，生产环境建议显式配置。
- `DOGEBOT_FEISHU_REACTION_RATE`：普通消息自动添加表情的概率，支持 `0.1` 或 `10` 这种百分比写法，默认 `0.1`。
- `DOGEBOT_FEISHU_REACTION_EMOJIS`：自动 reaction 的候选 emoji key，逗号分隔，默认 `OK,DONE,THUMBSUP,HEART,LAUGH`。
- `DOGEBOT_FEISHU_REPEAT_RATE`：普通消息自动复读的概率，默认 `0.05`。
- `DOGEBOT_FEISHU_REPEAT_MAX_CHARS`：允许复读的最大文本长度，默认 `300`。
- `DOGEBOT_FEISHU_IMITATE_RATE`：普通消息触发大模型模仿接话的概率，默认 `0.05`。
- `DOGEBOT_FEISHU_IMITATE_CONTEXT_SIZE`：模仿接话时带入的最近群聊消息条数，默认 `8`。
- `DOGEBOT_LLM_URL` / `DOGEBOT_LLM_BASE_URL` / `OPENAI_BASE_URL`：OpenAI 兼容接口地址，支持传 `/v1` 基地址或完整 `/chat/completions` 地址。
- `DOGEBOT_LLM_API_KEY` / `OPENAI_API_KEY`：OpenAI 兼容接口 Key。
- `DOGEBOT_LLM_MODEL` / `OPENAI_MODEL`：模仿接话使用的模型名。
- `DOGEBOT_LLM_TIMEOUT_MS`：大模型请求超时时间，默认 `15000`。
- `DOGEBOT_LLM_MAX_TOKENS`：大模型回复 token 上限，默认 `160`。

## 宝塔面板长期运行

推荐在宝塔里用 Node 项目或 PM2 管理器运行编译后的 `dist/index.js`，不要直接运行 TypeScript 开发命令。

首次部署：

```bash
cd /www/wwwroot
git clone <your-repo-url> DogeBot
cd DogeBot/apps/server
pnpm install
pnpm build
pnpm prune --prod
```

`pnpm prune --prod` 会在构建后移除 `typescript`、`tsx` 等开发依赖，减少服务端长期运行时的磁盘占用。如果你在本地构建后只上传 `dist`，服务器上也可以只执行 `pnpm install --prod`。

创建固定数据目录和管理员用户：

```bash
mkdir -p /www/wwwroot/DogeBot-data
cd /www/wwwroot/DogeBot/apps/server
DOGEBOT_DATA_DIR=/www/wwwroot/DogeBot-data pnpm add-user admin 'change-me'
```

宝塔 Node 项目建议配置：

- 项目目录：`/www/wwwroot/DogeBot/apps/server`
- 启动文件：`dist/index.js`
- 启动命令：`node dist/index.js`
- 端口：`3000`
- Node 版本：建议 `22.x`
- 环境变量：`PORT=3000`
- 环境变量：`DOGEBOT_DATA_DIR=/www/wwwroot/DogeBot-data`
- 环境变量：`DOGEBOT_AUTH_SECRET=<一段足够长的随机字符串>`
- 环境变量：`DOGEBOT_FEISHU_DEBUG=0`
- 环境变量：`DOGEBOT_LLM_BASE_URL=https://api.openai.com/v1`
- 环境变量：`DOGEBOT_LLM_API_KEY=<OpenAI 兼容接口 Key>`
- 环境变量：`DOGEBOT_LLM_MODEL=<模型名>`

如果直接使用 PM2：

```bash
cd /www/wwwroot/DogeBot/apps/server
PORT=3000 \
DOGEBOT_DATA_DIR=/www/wwwroot/DogeBot-data \
DOGEBOT_AUTH_SECRET='<一段足够长的随机字符串>' \
DOGEBOT_FEISHU_DEBUG=0 \
DOGEBOT_LLM_BASE_URL='https://api.openai.com/v1' \
DOGEBOT_LLM_API_KEY='<OpenAI 兼容接口 Key>' \
DOGEBOT_LLM_MODEL='<模型名>' \
pm2 start dist/index.js --name dogebot-server --update-env
pm2 save
```

更新代码：

```bash
cd /www/wwwroot/DogeBot
git pull
cd apps/server
pnpm install
pnpm build
pnpm prune --prod
pm2 restart dogebot-server --update-env
```

部署注意事项：

- 不要在仓库根目录执行 `pnpm install`，也不要让宝塔自动用 npm 安装依赖；服务端是独立项目，依赖必须在 `apps/server` 目录通过 `pnpm install` 管理。构建完成后可执行 `pnpm prune --prod` 减少磁盘占用。
- SQLite 数据目录建议固定为项目外的 `/www/wwwroot/DogeBot-data`，这样更新或重建项目不会丢数据库。
- 飞书长连接是服务端主动连接飞书，不要求服务器有公网入口；但桌面客户端需要能访问 `PORT` 对应的 HTTP API。
- 如果桌面客户端走公网访问，建议在宝塔里配置反向代理到 `http://127.0.0.1:3000` 并开启 HTTPS。
- `better-sqlite3` 是 native 依赖，首次安装失败时，先安装 `python3`、`make`、`gcc/g++` 等基础编译工具。

## 数据表

- `users`：本地登录用户。
- `feishu_bots`：飞书 bot 绑定信息，包含 `user_id`，用于隔离不同用户的 bot。
- `at_users_record`：`/users` 命令记录，按 `bot_id + at_by + at_who` 唯一记录，支持 `sort_order` 排序和 `deleted_at` 软删除。
- `douyin_aweme_records`：抖音收藏记录，支持通过 `status = 'delete'` 和 `deleted_at` 软删除；随机读取会排除删除状态。
- `feishu_bot_default_commands`：每个 bot 的默认兜底指令，以及首次设置 `/set-default` 的飞书用户管理员。

## REST API

- `POST /api/login`：登录，入参为 `{ "username": "...", "password": "..." }`。
- `GET /api/feishu/bots`：查询当前用户绑定的 bot。
- `GET /api/feishu/connections`：查询服务端当前维护的飞书长连接状态。
- `POST /api/feishu/bots`：绑定当前用户的 bot。
- `POST /api/feishu/bots/:id/probe`：探测当前用户的 bot 凭证是否有效。
- `POST /api/feishu/qr-registration/begin`：发起飞书扫码创建机器人流程，返回扫码链接和 `deviceCode`。
- `POST /api/feishu/qr-registration/poll`：轮询扫码授权结果，成功后创建 bot 绑定并启动长连接。
- `DELETE /api/feishu/bots/:id`：删除当前用户的 bot，并关闭对应长连接。
- `POST /feishu/webhook/:id`：飞书 webhook 兜底入口。

## 扫码创建 bot

扫码创建流程参考 Hermes：

- `begin`：调用注册接口 `init` 检查是否支持 `client_secret`，再调用 `begin` 获取 `device_code` 和扫码链接。
- `begin` 请求使用 `archetype=PersonalAgent`，依赖飞书模板创建并预置机器人、权限、长连接事件订阅等配置。
- `poll`：客户端按 `interval` 轮询；如果飞书返回 `client_id` 和 `client_secret`，服务端立即写入 `feishu_bots`。
- 绑定完成：服务端调用 `/open-apis/bot/v3/info` 探测机器人信息，并为新 bot 启动独立飞书长连接。

如果扫码创建后的 bot 长连接已连接但收不到消息，需要回到飞书开放平台检查模板配置是否实际生效，包括机器人能力、`im.message.receive_v1` 事件订阅、长连接接收方式、机器人发消息权限和应用发布状态。

手动绑定已有应用时，服务端不会也不能通过普通 OpenAPI 修改开放平台后台配置。请先在开放平台完成机器人能力、权限、事件订阅和发布，再把 `App ID` / `App Secret` 绑定到 DogeBot。

## 飞书消息处理

服务端默认使用飞书长连接接收事件。收到 `im.message.receive_v1` 后：

- 如果是 `/users`、`/douyin`、`/set-default`、`/add-cron` 等命令，优先按命令逻辑处理。
- 如果配置了 bot 默认兜底指令，继续执行默认指令。
- 普通文本消息不会要求 @ 机器人；服务端会按概率自动触发消息 reaction、复读、以及大模型模仿接话。
- 大模型模仿接话需要配置 OpenAI 兼容接口的 URL、Key 和 model；未配置时只会跳过该项，不影响 reaction 和复读。

飞书卡片中的 at 用户格式：

```text
<at id=ou_xxx></at>
```

## `/users` 命令

- `/users @Alice @Bob`：记录当前发起人 at 过 Alice 和 Bob。
- `/users`：返回当前发起人的历史 at 列表。
- `/users delete`：软删除当前发起人的全部历史记录。
- `/users delete @Alice`：软删除指定用户。
- `/users top @Alice`：将指定用户排到卡片最前。
- `/users new 3`：只返回最新加入的 3 个用户。

## `/douyin` 命令

- `/douyin {模拟点击文案} [--count n]`：随机发送匹配文案的抖音收藏视频。
- `/douyin --delete {aweme_id}`：软删除当前 bot 绑定用户名下的指定抖音收藏记录，`aweme_id` 必须是大于 5 位的数字，且只有该 bot 的 `/set-default` 管理员可以执行。

## `/set-default` 命令

- `/set-default "{兜底指令}"`：设置当前 bot 的默认兜底指令。
- 每个 bot 第一次成功执行 `/set-default` 的飞书用户会被记录为管理员；之后只有这个管理员可以继续修改默认兜底指令。
