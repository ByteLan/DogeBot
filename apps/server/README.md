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
- `DOGEBOT_FEISHU_IMAGE_REPEAT_RATE`：图片/图文首图/表情包自动复读为新消息的概率；未配置时默认 `0`。该能力默认关闭，只有显式执行 `/media-repeat --enable` 的会话才会命中概率后触发。
- `DOGEBOT_FEISHU_IMAGE_REVERSE_IMAGE_RATE`：聊天消息中的图片触发镜像反转后发送为新图片的概率；未配置时默认 `0.05`。该能力默认开启，可用 `/image-reverse --disable` 针对单个会话关闭。
- `DOGEBOT_FEISHU_IMAGE_REVERSE_STICKER_RATE`：聊天消息中的表情包触发镜像反转后发送为新图片的概率；未配置时默认 `0.2`。该能力默认开启，可用 `/sticker-reverse --disable` 针对单个会话关闭。
- 图片/表情包复读在完整下载前会先探测资源大小；如果探测不到大小，则边下载边限制。只有严格小于 `4MB` 的资源才会继续下载并复读；下载后的原始资源会缓存在系统临时目录下的 `dogebot-feishu-image-cache`，例如 macOS 上通常是 `/var/folders/.../T/dogebot-feishu-image-cache`，3 天未命中的缓存会定时清理，命中缓存会刷新时间戳。
- `/image-reverse` 与 `/sticker-reverse` 会在发送前随机选择水平或垂直中心线，再把图片一侧镜像覆盖到另一侧；处理后的临时文件会放在系统临时目录下的 `dogebot-feishu-image-processed`，例如 macOS 上通常是 `/var/folders/.../T/dogebot-feishu-image-processed`，发送完成后立即删除。该能力现在依赖 `python3` 和 `pillow`，可通过 `python3 -m pip install -r apps/server/requirements.txt` 安装。
- `DOGEBOT_FEISHU_REPEAT_MAX_CHARS`：允许复读的最大文本长度，默认 `300`。
- `DOGEBOT_FEISHU_IMITATE_RATE`：普通消息触发大模型模仿接话的概率，默认 `0.05`。
- `DOGEBOT_FEISHU_IMITATE_CONTEXT_SIZE`：模仿接话时带入的最近群聊消息条数，默认 `8`。
- `DOGEBOT_LLM_URL` / `DOGEBOT_LLM_BASE_URL` / `OPENAI_BASE_URL`：OpenAI 兼容接口地址，支持传 `/v1` 基地址或完整 `/chat/completions` 地址。
- `DOGEBOT_LLM_API_KEY` / `OPENAI_API_KEY`：OpenAI 兼容接口 Key。
- `DOGEBOT_LLM_MODEL` / `OPENAI_MODEL`：模仿接话使用的模型名。
- `DOGEBOT_LLM_TIMEOUT_MS`：大模型请求超时时间，默认 `15000`。
- `DOGEBOT_LLM_MAX_TOKENS`：大模型回复 token 上限，默认 `160`。
- `DOGEBOT_LLM_DISABLE_THINKING`：设为 `1` 时，请求 OpenAI 兼容接口会额外带 `enable_thinking: false`，用于关闭支持该参数的模型思考模式。
- `/open-api/v1/byte-style` 与 `/open-api/v1/scale-new-heights` 现在直接通过 `@napi-rs/canvas` 在服务端出图；所需字体资源已随 `apps/server/assets/fonts` 一起纳入仓库，并会在构建时复制到 `dist/assets/fonts`，其中包含 emoji / symbol fallback 字体以支持 `⛰` 等符号。
- `DOGEBOT_STYLE_STICKER_RENDER_CONCURRENCY`：字节范/勇攀高峰生图的全局并发数，默认 `2`；`/open-api/v1/byte-style`、`/open-api/v1/scale-new-heights`、飞书命令生图、随机生图、卡片预览共用这一组并发额度。
- `DOGEBOT_STYLE_STICKER_RENDER_QUEUE_MAX`：字节范/勇攀高峰生图的等待队列上限，默认 `20`；超过后新任务会立即抛出 `QUEUE_FULL` 错误，避免请求堆积占用内存。
- `DOGEBOT_STYLE_STICKER_RENDER_TIMEOUT_MS`：单个字节范/勇攀高峰生图任务的最大执行时间（毫秒），默认 `20000`；超时后会立即释放并发额度并抛出 `TASK_TIMEOUT` 错误，避免卡死后续任务。
- `DOGEBOT_PYTHON_TASK_CONCURRENCY`：服务端调用 `python3` 子进程任务的全局并发数，默认 `2`；当前主要用于图片/表情包镜像反转。
- `DOGEBOT_PYTHON_TASK_QUEUE_MAX`：`python3` 子进程任务的等待队列上限，默认 `20`；超过后新任务会立即抛出 `QUEUE_FULL` 错误。
- `DOGEBOT_PYTHON_TASK_TIMEOUT_MS`：单个 `python3` 子进程任务的最大执行时间（毫秒），默认 `20000`；超时后会通过 `AbortSignal` 结束子进程并抛出 `TASK_TIMEOUT` 错误。
- `OpenApiBaseUrl`：`/help` 卡片里展示 OpenAPI 示例地址时使用的基础域名，默认 `https://doge.bbyte.cn`；同时兼容 `DOGEBOT_OPEN_API_BASE_URL` 与 `OPEN_API_BASE_URL`。
- `DOGEBOT_FEISHU_BYTE_STYLE_RATE`：普通文本消息随机生成为“字节范”图片的概率，默认 `0.05`。该能力默认开启，可用 `/byte-style --disable` 或 `/字节范 --disable` 针对单个会话关闭。
- `DOGEBOT_FEISHU_SCALE_NEW_HEIGHTS_RATE`：普通文本消息随机生成为“勇攀高峰”图片的概率，默认 `0.05`。该能力默认开启，可用 `/scale-new-heights --disable` 或 `/勇攀高峰 --disable` 针对单个会话关闭。
- `DOGEBOT_FEISHU_STYLE_STICKER_MAX_CHARS`：`/byte-style`、`/字节范`、`/scale-new-heights` 与 `/勇攀高峰` 在当前会话未显式设置 `--max` 时的默认最大处理字符数，默认 `10`。
- `DOGEBOT_FEISHU_STYLE_STICKER_MAX_CHARS_LIMIT`：随机生图允许处理的绝对字符上限。即使会话里配置了更大的 `--max`，或者 `DOGEBOT_FEISHU_STYLE_STICKER_MAX_CHARS` 更大，实际处理长度也不会超过这个值；未配置时默认 `150`。
- 飞书里直接发送 `/byte-style`、`/字节范`、`/scale-new-heights` 或 `/勇攀高峰` 且不带其他参数时，如果当前消息不在话题里且引用消息里有文字，会直接用引用文字生图；否则会回复一个交互卡片：顶部展示随机颜色和随机渐变角度生成的预览图，下方可编辑文案、通过下拉选择两个常用色，也可填写自定义 `#RRGGBB` 色值，并填写渐变角度；通过“预览”刷新卡片，通过“发送”撤回卡片后发送图片，或通过“撤回”只撤回卡片。

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
- `feishu_douyin_subscriptions`：飞书会话级抖音订阅，按 `bot_id + chat_id + click_text` 记录当前群聊或单聊订阅了哪些模拟点击文案；订阅触发条件是对应 `click_text` 下有新的 `aweme_id` 成功入库。
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

- 如果是 `/help`、`/users`、`/douyin`、`/set-default`、`/add-cron`、`/reverse`、`/反转`、`/revert`、`/撤回` 等命令，优先按命令逻辑处理。
- 如果配置了 bot 默认兜底指令，继续执行默认指令。
- 普通文本消息不会要求 @ 机器人；服务端会按概率自动触发消息 reaction、复读、以及大模型模仿接话。
- 大模型模仿接话需要配置 OpenAI 兼容接口的 URL、Key 和 model；未配置时只会跳过该项，不影响 reaction 和复读。

飞书卡片中的 at 用户格式：

```text
<at id=ou_xxx></at>
```

## `/help` 命令

- `/help`：用飞书卡片表格返回当前支持的斜杠命令、可填参数和功能说明；卡片中还会单独展示 4 个 OpenAPI 地址与参数说明，以及当前会话的概率、随机生图 `max`、`/douyin` 订阅和 cron 管理表单，可填写后提交，或取消后折叠该表单。

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
- `/douyin --subscribe {模拟点击文案}`：为当前发消息的群聊或与 bot 的单聊订阅该 `click_text` 分组；后续桌面端同步时，只有该分组有新的 `aweme_id` 成功入库，才会把新增视频链接发到当前会话，已有库存不会补发。
- `/douyin --unsubscribe {模拟点击文案}`：取消当前会话对该 `click_text` 分组的订阅。

`/douyin --subscribe` 订阅的是服务端入库分组，不是桌面端任务 ID、`favoriteUrl`、`collectListUrl` 或请求 URL 筛选字符串。桌面端上报 `/api/douyin/aweme-records` 时会提交 `{ clickText, awemeIds }`，服务端按 `(user_id, click_text, aweme_id)` 去重；只有 `INSERT OR IGNORE` 实际插入的新 `aweme_id` 会触发订阅通知。

## `/set-default` 命令

- `/set-default "{兜底指令}"`：设置当前 bot 的默认兜底指令。
- 每个 bot 第一次成功执行 `/set-default` 的飞书用户会被记录为管理员；之后只有这个管理员可以继续修改默认兜底指令。

## `/add-cron` 命令

- `/add-cron "*/5 * * * *" "/douyin 123 [--count n]"`：给当前会话添加定时任务。
- `/add-cron "*/5 * * * *"`：如果当前 bot 已设置 `/set-default`，可以省略第二个参数，定时执行默认兜底指令。
- `/add-cron --list`：列出当前会话已有的定时任务，并按序号展示。
- `/add-cron --delete 2`：删除当前会话序号为 2 的定时任务；序号以 `/add-cron --list` 的结果为准。

## `/reverse` / `/反转` 命令

- `/reverse`、`/反转`，或直接发送包含 `reverse` / `反转` 关键词的消息：优先读取当前消息里的第一张图片；如果当前消息没有图片，则继续尝试读取该消息引用的上一条消息里的图片或表情包。
- 找到图片或表情包后，服务端会复用现有镜像脚本做一次随机轴向、随机方向的镜像反转，并把结果作为新图片发送到当前会话。
- 如果当前消息和引用消息里都没有可处理的图片或表情包，会回复提示文本，不会触发现有的会话级概率开关。

## `/revert` / `/撤回` 命令

- `/revert`、`/撤回`：必须引用一条消息，或在 bot 发起的话题里使用。服务端会优先检查当前消息的 `parent_id`，再检查 `root_id`；只要对应消息是当前 bot 自己发出的，就会直接撤回。
- 普通用户只能撤回当前会话里的 bot 消息。该功能不依赖本地数据库记录已发送消息，而是直接调用飞书的消息查询接口确认被引用消息的 `chat_id`、`sender` 和撤回状态，再调用飞书消息撤回接口执行撤回。

## 被动能力开关命令

- `/reaction [--enable|--disable] [--rate 0.12]`：当前会话开启或关闭随机贴表情，并可设置会话级概率。
- `/repeat [--enable|--disable] [--rate 0.12]`：当前会话开启或关闭文本复读，并可设置会话级概率。
- `/llm-reply [--enable|--disable] [--rate 0.12]`：当前会话开启或关闭大模型接话，并可设置会话级概率。
- `/media-repeat [--enable|--disable] [--rate 0.12]`：当前会话开启或关闭图片/表情包复读，并可设置会话级概率。
- `/image-reverse [--enable|--disable] [--rate 0.12]`：当前会话开启或关闭图片镜像反转，并可设置会话级概率。
- `/sticker-reverse [--enable|--disable] [--rate 0.12]`：当前会话开启或关闭表情包镜像反转，并可设置会话级概率。
- 所有会话级 `--rate` 都会优先于环境变量默认值生效，但不能超过该能力全局默认概率的 5 倍。

## `/byte-style`、`/字节范`、`/scale-new-heights` 与 `/勇攀高峰` 命令

- `/byte-style 测试文案` 或 `/字节范 测试文案`：立即把文本渲染成“字节范”图片并发送到当前会话。
- `/scale-new-heights 测试文案` 或 `/勇攀高峰 测试文案`：立即把文本渲染成“勇攀高峰”图片并发送到当前会话。
- `/byte-style`、`/字节范`、`/scale-new-heights` 或 `/勇攀高峰`：不带参数时，如果当前消息不在话题里，会先检查引用消息；如果引用消息里有文字，就直接用引用文字生图并发送到当前会话；如果当前消息在话题里、没有引用，或引用消息里没有文字，则会回复交互卡片。卡片可输入文案、通过下拉选择两个常用色，也可填写自定义 `#RRGGBB` 色值，并填写渐变角度；点击“预览”会更新顶部预览图，点击“发送”会撤回卡片并把图片发到当前会话，点击“撤回”只撤回卡片。
- `/byte-style --enable` / `/byte-style --disable`，以及 `/字节范 --enable` / `/字节范 --disable`：当前会话重新开启或关闭“字节范”随机生图。该能力默认开启。
- `/scale-new-heights --enable` / `/scale-new-heights --disable`，以及 `/勇攀高峰 --enable` / `/勇攀高峰 --disable`：当前会话重新开启或关闭“勇攀高峰”随机生图。该能力默认开启。
- `/byte-style --rate 0.12`、`/字节范 --rate 12`、`/scale-new-heights --rate 0.12`、`/勇攀高峰 --rate 12`：设置当前会话该风格随机生图概率，支持小数或百分数写法；会话级 rate 优先于环境变量默认值，但不能超过全局默认概率的 5 倍。
- `/byte-style --max 12`、`/字节范 --max 12`、`/scale-new-heights --max 12`、`/勇攀高峰 --max 12`：设置当前会话该风格随机生图允许处理的最大文本长度；超过该长度则不会处理。如果配置值超过 `DOGEBOT_FEISHU_STYLE_STICKER_MAX_CHARS_LIMIT`，实际仍会按上限截断。
- 同一条普通文本消息在“文本复读”“字节范随机生图”“勇攀高峰随机生图”三者之间互斥；即使同时命中多个概率，也只会随机选择其中一个执行。
