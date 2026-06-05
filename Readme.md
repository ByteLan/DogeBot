# DogeBot

DogeBot 仓库当前包含一个 Node.js 服务端和一个 Electron 桌面客户端。两者按独立项目管理，各自有自己的 `package.json`、`pnpm-lock.yaml` 和 `node_modules`；服务端负责用户登录、SQLite 数据持久化、飞书机器人绑定，以及为每个已绑定机器人维护独立的飞书长连接；桌面客户端用于登录服务端并管理飞书机器人绑定。

## 项目结构

```text
DogeBot/
├── apps/
│   ├── server/    # Node.js 服务端，独立 pnpm 项目
│   └── desktop/   # Electron 桌面客户端，独立 pnpm 项目
├── common/        # 保留的 Rush 配置
├── package.json
└── rush.json
```

## 应用说明

- `apps/server`：服务端应用，提供 REST API、SQLite 存储、多用户登录、飞书 bot 手动绑定、扫码创建绑定、飞书 WebSocket 长连接、`/users` 命令处理。
- `apps/desktop`：桌面客户端，提供服务端 URL、用户名、密码登录入口，并支持手动绑定、扫码创建绑定、探测、删除当前用户绑定的飞书 bot。

## 快速开始

安装并启动服务端：

```bash
cd /Users/bytedance/flux2/DogeBot/apps/server
pnpm install
pnpm add-user admin 'change-me'
pnpm dev
```

安装并启动桌面客户端：

```bash
cd /Users/bytedance/flux2/DogeBot/apps/desktop
pnpm install
pnpm dev
```

注意：日常不要在根目录执行 `pnpm install`。`apps/server` 和 `apps/desktop` 是两个独立 pnpm 项目，分别在各自目录安装依赖和运行脚本。

如果需要临时使用保留的 Rush 配置，可以在根目录执行 `pnpm rush:update` 或 `pnpm rush:build`。

## 服务端能力

默认服务地址是 `http://127.0.0.1:3000`。

主要能力：

- 多用户登录：使用本地用户名和密码登录，登录后通过 Bearer token 调用 API。
- 用户隔离：每个用户只能看到和管理自己绑定的飞书 bot。
- 多 bot 绑定：每个用户可以绑定多个飞书 bot。
- 扫码创建绑定：复用 Hermes 的飞书注册流程，支持通过扫码创建新飞书机器人并自动绑定到当前用户。
- 独立长连接：服务端为每个启用的 bot 创建独立飞书 WebSocket 长连接，并在服务启动时自动恢复。
- SQLite 持久化：用户、bot 绑定、`/users` 命令记录都存储在本地 SQLite 数据库中。
- Webhook 兜底：保留 `/feishu/webhook/:botId` 作为飞书事件回调的备用调试入口。

环境变量：

- `PORT`：服务端 HTTP 端口，默认 `3000`。
- `DOGEBOT_DATA_DIR`：SQLite 数据目录，默认 `apps/server/data`。
- `DOGEBOT_AUTH_SECRET`：登录 token 签名密钥；开发环境有默认值，生产环境建议显式配置。

## 飞书机器人配置

推荐方式是在桌面客户端点击“扫码创建并绑定”：

- 服务端调用飞书 `/oauth/v1/app/registration` 完成 `init -> begin -> poll` 注册流程。
- 注册请求使用 `archetype=PersonalAgent`，依赖飞书的 Agent/自动回复机器人模板创建应用并预置机器人相关配置。
- 客户端展示扫码链接并自动轮询授权结果。
- 授权成功后，服务端保存新应用的 `appId`、`appSecret`，探测 bot 信息，并立即启动该 bot 的长连接。

如果扫码创建出的应用仍然无法收到消息，需要到飞书开放平台检查模板是否已经生效：机器人能力、长连接事件订阅、`im.message.receive_v1` 事件、发消息权限和应用发布状态。

也可以手动绑定已有应用。手动绑定时，DogeBot 只能使用你填入的 `appId/appSecret` 建立长连接，不能替你修改开放平台后台配置。

在飞书开放平台创建或配置自建应用：

- 开启机器人能力。
- 开通接收消息和机器人发消息相关权限，例如接收单聊消息、接收群聊中 @ 机器人消息、以机器人身份发消息。
- 在事件订阅中选择“使用长连接接收事件”。
- 添加 `im.message.receive_v1` 事件。
- 发布应用版本，使权限和事件订阅生效。
- 使用长连接模式时，服务端会通过 `@larksuiteoapi/node-sdk` 的 `WSClient` 建立连接。
- 如需 webhook 兜底，可将事件回调地址配置为 `https://<your-public-server>/feishu/webhook/<botId>`。

在桌面客户端绑定 bot 时需要填写：

- `name`：本地展示名称。
- `appId`：飞书应用 App ID。
- `appSecret`：飞书应用 App Secret。
- `domain`：`feishu` 或 `lark`。
- `verificationToken`：可选，webhook 校验使用。
- `encryptKey`：可选，预留给加密事件使用。

## `/users` 命令

用户向 bot 发送 `/users` 命令时，服务端会按 `bot_id + at_by + at_who` 记录关系。返回内容始终是飞书消息卡片，卡片里会把该发起人在当前 bot 下历史记录的 `at_who` 全部 at 出来。

支持命令：

- `/users @Alice @Bob`：记录当前发起人 at 过 Alice 和 Bob，并返回当前列表。
- `/users`：不新增记录，只返回当前发起人的历史 at 列表。
- `/users delete`：软删除当前发起人在当前 bot 下的全部历史 at 记录。
- `/users delete @Alice`：只软删除 Alice。
- `/users top @Alice`：记录 Alice，并把 Alice 排到返回卡片的最前面。
- `/users new 3`：只返回最新加入的 3 个 `at_who`。

飞书卡片中的 at 用户格式为：

```text
<at id=ou_xxx></at>
```

## 宝塔面板部署

推荐用宝塔的 Node 项目或 PM2 管理器长期运行 `apps/server/dist/index.js`。飞书事件接收走服务端主动发起的 WebSocket 长连接，不要求服务器有公网入口；但桌面客户端如果不在同一台机器上，需要能访问服务端 HTTP API。

服务器准备：

```bash
cd /www/wwwroot
git clone <your-repo-url> DogeBot
cd DogeBot/apps/server
pnpm install
pnpm build
pnpm prune --prod
```

`pnpm prune --prod` 会在构建后移除 `typescript`、`tsx` 等开发依赖，减少服务端长期运行时的磁盘占用。如果你在本地构建后只上传 `dist`，服务器上也可以只执行 `pnpm install --prod`。

创建固定数据目录。SQLite 数据库建议放在项目目录外，避免后续更新代码时误删：

```bash
mkdir -p /www/wwwroot/DogeBot-data
cd /www/wwwroot/DogeBot/apps/server
DOGEBOT_DATA_DIR=/www/wwwroot/DogeBot-data pnpm add-user admin 'change-me'
```

宝塔 Node 项目配置：

- 项目目录：`/www/wwwroot/DogeBot/apps/server`
- 启动文件：`dist/index.js`
- 启动命令：`node dist/index.js`
- 运行端口：`3000`，或自定义后同步设置 `PORT`
- Node 版本：建议 `22.x`
- 环境变量：`PORT=3000`
- 环境变量：`DOGEBOT_DATA_DIR=/www/wwwroot/DogeBot-data`
- 环境变量：`DOGEBOT_AUTH_SECRET=<一段足够长的随机字符串>`
- 环境变量：`DOGEBOT_FEISHU_DEBUG=0`

如果用 PM2 命令启动：

```bash
cd /www/wwwroot/DogeBot/apps/server
PORT=3000 \
DOGEBOT_DATA_DIR=/www/wwwroot/DogeBot-data \
DOGEBOT_AUTH_SECRET='<一段足够长的随机字符串>' \
DOGEBOT_FEISHU_DEBUG=0 \
pm2 start dist/index.js --name dogebot-server --update-env
pm2 save
```

更新代码后重新构建并重启：

```bash
cd /www/wwwroot/DogeBot
git pull
cd apps/server
pnpm install
pnpm build
pnpm prune --prod
pm2 restart dogebot-server --update-env
```

注意事项：

- 不要在根目录执行 `pnpm install`，也不要让宝塔自动用 npm 安装依赖；服务端是独立项目，应在 `apps/server` 目录执行 `pnpm install`。构建完成后可执行 `pnpm prune --prod` 减少磁盘占用。
- `better-sqlite3` 是 native 依赖，首次 `pnpm install` 需要服务器具备基础编译环境；如果安装失败，先在宝塔/系统里安装 `python3`、`make`、`gcc/g++`。
- 如果只给桌面客户端内网访问，可以不配置宝塔反向代理；如果需要公网访问登录 API，再在宝塔里反向代理到 `http://127.0.0.1:3000`，并配置 HTTPS。
- 飞书长连接只需要服务器能主动访问公网，不需要配置公网 webhook URL。

## 常用命令

```bash
cd apps/server && pnpm install   # 安装服务端依赖
cd apps/desktop && pnpm install  # 安装桌面端依赖
```

在 `apps/server` 中：

```bash
pnpm dev                  # 开发模式启动服务端
pnpm build                # 编译服务端
pnpm start                # 运行编译后的服务端
pnpm add-user <用户名> <密码> # 创建登录用户
```

在 `apps/desktop` 中：

```bash
pnpm dev    # 开发模式启动 Electron 客户端
pnpm build  # 编译 Electron 客户端
```
