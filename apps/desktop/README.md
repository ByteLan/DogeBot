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
- 监听并同步抖音收藏列表，支持多个活跃任务按顺序执行。

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

## 抖音收藏监听

桌面端使用独立的 Electron 持久会话 `persist:dogebot-douyin` 保存 douyin.com 登录态。点击“登录 douyin.com”完成登录后，可以在“抖音收藏监听”里配置多个任务。

共享配置：

- 短间隔、长间隔和 retry 次数：所有活跃任务共享一套调度节奏。
- 隐藏 Douyin 窗口后台执行：所有任务共享同一个 Douyin 窗口。
- 点击失败立即弹到前台：模拟点击失败时把 Douyin 窗口显示出来，便于排查页面状态。

每个任务单独配置：

- `favoriteUrl`：任务开始时打开的抖音页面地址。
- `collectListUrl`：要捕获的接口基础路径，匹配时只比较 `origin + pathname`。
- 请求 URL 筛选字符串：对完整请求 URL 做包含匹配，例如 `collects_id=7648523880352618283`。
- `clickText`：用于模拟点击页面上包含该文案的元素，也是同步到服务端后的 `click_text` 分组。
- 不点击，仅刷新页面并监听 API：开启后任务只打开 `favoriteUrl`，不执行模拟点击。

三个下拉字段 `favoriteUrl`、`collectListUrl`、请求 URL 筛选字符串都支持输入新值；点击“开始监听”时，当前活跃任务里的输入会写入本地历史，后续可从下拉框选择，也可以删除非默认历史项。

任务执行方式：

- 多个活跃任务在同一个 Douyin 窗口中串行执行。
- 每个任务会打开自己的 `favoriteUrl`，等待 5 秒，再按配置决定是否点击 `clickText`。
- 任务会等待匹配接口返回，最多等待 5 秒；任务结束后再等待 5 秒进入下一个任务。
- 监听使用页面内 fetch/XHR hook，不阻塞网络请求；即使不在刷新任务窗口内，只要监听仍在运行，页面中出现匹配请求也会继续上报。

同步到服务端：

- 捕获到接口 body 后，桌面端提取 `aweme_list[].aweme_id`。
- 桌面端调用服务端 `/api/douyin/aweme-records`，提交 `{ clickText, awemeIds }`。
- 服务端按 `(user_id, click_text, aweme_id)` 去重入库；只有新插入的 `aweme_id` 会触发飞书 `/douyin --subscribe {clickText}` 订阅通知。

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

- 客户端负责绑定管理和群聊界面，通过 server 访问飞书，不直接持有应用凭证。
- 所有飞书事件处理都在服务端完成。
- 删除 bot 绑定后，服务端会关闭对应 bot 的长连接。
- 抖音监听依赖本机 Electron 会话和页面内 hook；如果长期收不到接口返回，优先检查 Douyin 窗口是否登录、任务的 `collectListUrl` 和请求 URL 筛选字符串是否匹配实际请求。

## 飞书群聊工作区

登录后点击「群聊」，选择机器人和群即可主动读取历史。支持向上加载历史、查看话题、文本与图片发送、引用/话题回复、复制文本和图片预览；发送身份始终是所选机器人。图片可选择、粘贴或拖拽，最大 10 MiB，图片和文字分别发送。

- 内存缓存跨机器人合计最近访问的 10 个群，后台新消息不改变访问顺序。
- 每群主线、话题、引用详情合计最多 300 条历史实体；待发送动作最多 3 个，单独展示。
- 消息缓存估算预算共 16 MiB，图片 Blob 预算共 16 MiB。浏览更早历史时会释放离开视图的页，仍可通过飞书重新加载。
- 断线恢复后校准当前最新页；阅读旧历史时用「返回最新」重建窗口，不把中间有缺口的两段消息直接拼接。
- 消息、草稿和图片不会保存到 localStorage、IndexedDB 或文件。窗口隐藏到托盘时内存仍在；退出账号、重载 renderer 或真正退出应用后清空。
- 未支持的消息类型显示摘要；卡片提供文本/成员列表摘要，不运行第三方卡片按钮。没有离线查看、关键词搜索、个人飞书身份发送或脱机发送队列。
- 若提示“发送结果待确认”，先刷新最新消息，再决定是否使用同一发送编号重试，避免不确定结果的重复发送。

在 `apps/desktop` 下验证缓存、竞态、分页及 SSE 解析：

```bash
node --import tsx scripts/verify-feishu-chat.ts
```

飞书权限及 SSE 部署要求见 [server 文档](../server/README.md)，具体设计见 [实现方案](../../docs/2026-10-16/feishu-desktop-chat-implementation-plan.md)。
