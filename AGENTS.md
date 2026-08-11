# AGENTS.md

面向 AI 编码助手与后续开发者的开发规范。改动本仓库前请先读本文件。

## 仓库结构

DogeBot 是多项目仓库(Rush 管理),但**各应用是独立的 pnpm 项目**,各自持有 `package.json` / lockfile / `node_modules`:

- `apps/server` —— Node.js 服务端(Express + better-sqlite3 + 飞书长连接)。本文件的规范主要面向它。
- `apps/desktop` —— Electron 桌面客户端。
- `apps/cli` —— 命令行工具。
- `common/` —— 保留的 Rush 配置。

**不要在仓库根目录执行 `pnpm install`。** 进入对应应用目录单独安装、构建、运行。

## 构建与校验(apps/server)

改完 server 代码后,提交前必须本地通过类型检查:

```bash
cd apps/server && npx tsc -p tsconfig.json --noEmit
```

- `pnpm dev` —— `tsx watch src/index.ts` 热重载开发。
- `pnpm build` —— `tsc` 编译到 `dist/` 并拷贝 `scripts/*.py`、`assets/`。
- `pnpm start` —— 运行 `dist/index.js`。

当前仓库**没有测试框架**。不要凭空引入 `jest`/`vitest` 依赖来"验证";用 `tsc --noEmit` 和必要时的最小可运行脚本自证。如需新增测试体系,先与维护者确认。

## TypeScript 约定

- `tsconfig` 为 `module: NodeNext` + `strict: true`。**相对导入必须带 `.js` 扩展名**(即使源文件是 `.ts`),例如 `import { db } from './db.js'`。漏写扩展名会编译失败。
- 保持 `strict`,不要用 `any` 逃逸;需要窄化返回类型时优先 `satisfies`。
- 匹配周边代码风格:2 空格缩进、单引号、无分号省略(现有代码带分号)、注释密度与命名向邻近文件看齐。

## 环境变量约定

- 统一前缀 `DOGEBOT_`,全大写下划线,语义分组(如 `DOGEBOT_DOUYIN_*`、`DOGEBOT_FEISHU_*`)。
- 集中解析:数值型配置一律走 [`config.ts`](apps/server/src/config.ts) 的解析器,不要在业务代码里裸 `Number(process.env.X)`。
  - `parsePositiveInt(raw, fallback)` —— 正整数,非法回退默认值。
  - `parsePositiveNumber(raw, fallback)` —— **正小数**(QPS、TTL 等允许小数的场景用它)。
  - `parseRate` / `parseConfigurableRate` —— 0~1 比率(支持传百分数,>1 自动 /100)。
  - `parseBooleanFlag`、`splitCsv`、`envString`(多别名取首个非空)。
- 变量单位写进注释,并在变量名/文档里体现:秒用 `_SECONDS`,小时用 `_HOURS`,毫秒用 `_MS`,并发用 `_CONCURRENCY`,队列上限用 `_QUEUE_MAX`。
- 新增环境变量时,同步更新 `Readme.md` 的环境变量段落和本文件下方清单。

## 外部请求 / 频控约定

对外部服务(抖音等)的网络探测**必须走统一的频控入口**,不要在新调用点直接发请求:

- 抖音视频有效性检测唯一网络函数:[`checkDouyinAwemeValidity`](apps/server/src/douyin-check.ts)。
- 唯一对外调用入口:[`checkDouyinAwemeValidityCached`](apps/server/src/douyin.ts) —— 内含 DB 标题缓存 + 全局频控队列 + 在途去重。**新增需要检测抖音的入口时复用它,不要绕过。**
- 频控调度器:[`douyin-check-queue.ts`](apps/server/src/douyin-check-queue.ts) —— 并发闸门 + QPS 平滑放行 + 按 key 的 in-flight 去重。同类"限速+去重"需求可参照此模式。
- 通用并发限制器:[`utils/concurrency.ts`](apps/server/src/utils/concurrency.ts)(带队列上限/超时),用于 Python 任务、贴纸渲染等 CPU/子进程任务。

设计原则:
- **探测失败绝不产生破坏性后果**。网络错误/超时/队列满一律视为"不确定"(`errored: true` 且 `valid: true`),调用方不得据此删除或跳过数据。
- 缓存命中直接返回,不进队列;高并发同 key 请求合并为一次真实请求。

抖音检测采用**两阶段**策略(参考 yt-dlp),各阶段可用 env 单独开关,均默认开:
- **阶段1** 移动端分享页 `iesdouyin.com/share/video/<id>`,抓 `<title>`。真实标题=有效(快路径)。注意抖音已不在 SSR 内嵌视频数据,失效视频与相当比例的有效视频都只返回兜底标题(`在抖音记录美好生活…` 或裸"抖音"),见 `isFallbackShareTitle`——兜底标题只表示"不确定,转阶段2"。
- **阶段2** Web 详情 API `www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=<id>`,靠 `ttwid` cookie(惰性缓存,不签名)。`aweme_detail` 非空=有效(取 `desc` 作真实标题),为 `null`=失效。这是**非官方接口**,抖音可能收紧(如强制 `a_bogus` 签名),届时降级为 `errored`(不误删),可用 env 关闭。
- 结果 `DouyinValidity` 携带 `stages[]`(每个执行/跳过阶段的 outcome/title/info)与 `decidedBy`,用 `formatDouyinCheckStages` 渲染进管理员卡片的「检测过程」。新增检测入口构造卡片时要带上 `checkInfo`。
- 缓存回读契约:有效结果标题**永不**以 `INVALID_TITLE_MARKER` 开头,确认失效结果**必须**以之开头(douyin.ts 靠 `startsWith` 回读有效性)。

## 数据库约定

- SQLite 通过 better-sqlite3,schema 与迁移集中在 [`db.ts`](apps/server/src/db.ts),用 `CREATE TABLE IF NOT EXISTS` + 幂等的列迁移(检测列是否存在再 `ALTER`)。新增列走同样的幂等迁移方式,不要假设旧库已有新列。
- 软删除用 `status = 'delete'` + `deleted_at`,查询活跃记录统一用 `ACTIVE_DOUYIN_RECORD_FILTER` 之类的共享过滤片段,不要各处手写。
- SQL 一律参数化(`?` 占位),禁止字符串拼接用户输入。

## 飞书(feishu)相关

- 每个启用的 bot 维护独立长连接,服务启动自动恢复。
- 各类通知/卡片、命令解析、cron 分别在 `feishu/` 下分模块;命令解析集中在 `feishu/commands/parsers.ts`,新增指令 flag 在此扩展。
- 给管理员发通知失败要 `try/catch` 并 `console.error`,不得让通知失败中断主流程。

## 日志

- 结构化日志:`console.error('[模块] 事件描述', { 关键字段, error: error instanceof Error ? error.message : String(error) })`。沿用现有 `[douyin]` / `[feishu]` / `[concurrency:name]` 前缀风格。

## 已登记的抖音频控相关环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `DOGEBOT_DOUYIN_CHECK_CONCURRENCY` | `1` | 检测并发数(整数,1=串行) |
| `DOGEBOT_DOUYIN_CHECK_QPS` | `1` | 每秒放行检测数(**支持小数**,如 0.5=每 2 秒一个) |
| `DOGEBOT_DOUYIN_CHECK_QUEUE_MAX` | `0` | 队列上限(整数,0=不限,超限降级为 errored) |
| `DOGEBOT_DOUYIN_CHECK_CACHE_HOURS` | `24` | DB 标题缓存新鲜期,单位小时(**支持小数**) |
| `DOGEBOT_DOUYIN_OPEN_API_CACHE_SECONDS` | `2` | 两个 OpenAPI 接口共用短缓存,单位秒(**支持小数**) |
| `DOGEBOT_DOUYIN_CHECK_STAGE1_ENABLED` | `true` | 是否启用检测阶段1(分享页) |
| `DOGEBOT_DOUYIN_CHECK_STAGE2_ENABLED` | `true` | 是否启用检测阶段2(详情 API);关闭后阶段1 兜底标题即判失效(旧行为) |

## 提交规范

- 遵循现有 Conventional Commits 风格(`feat(scope): ...` / `fix(scope): ...` / `refactor(scope): ...`),scope 用模块名(如 `douyin`、`feishu message handler`)。可用中文描述正文。
- 仅在用户明确要求时才提交或推送。
