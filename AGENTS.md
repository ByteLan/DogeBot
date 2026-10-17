# 开发协作规范

本文件面向 AI 编码助手与开发者。`CLAUDE.md` 是仅包含 `@AGENTS.md` 的普通文件，由 Claude Code 导入本文件；兼容 Windows、Linux 与 macOS，规则只维护一份，请勿改回软链接或复制整份规则。

## 先读规格，再改实现

- 开始改动前阅读 [产品规格索引](product-spec/README.md) 和对应模块文档，再检查相关代码；跨模块改动要阅读涉及的模块。
- `product-spec/<功能模块>/` 维护当前功能、交互、默认值、异常处理和能力边界。新增功能先补齐规格；行为发生变化时，在同一改动中更新相关规格和索引，避免文档与实现脱节。
- 调研、实现方案、关键取舍和验证结果默认在对话中说明，不主动新增或更新 `docs/` 等过程记录文档。仅在用户明确要求保存文档时落盘；使用 `docs/YYYY-MM-DD/` 时日期采用北京时间，并注明方案状态、验证范围及对应产品规格。
- README 与架构文档维护安装、部署和技术细节。修改接口、配置或运行方式时同步更新相应说明；计划能力不得写成已交付，构建通过不得表述为线上或跨平台验收通过。

## 项目与构建约定

- `apps/server`：Node.js、Express、原生 `node:sqlite`、飞书长连接；`apps/desktop`：Electron、React、Arco Design。`common/` 保留 Rush 配置，当前没有 `apps/cli`。
- server 使用 Node.js 24 或更新版本，满足当前贴纸依赖要求；不要只依据较宽的 package engines 推断整个应用可用。
- 各应用独立维护 `package.json`、lockfile 和 `node_modules`。**不要在仓库根目录执行 `pnpm install`**；进入对应应用安装和运行。
- **保留 server 的 `dist/src/index.js` 部署入口**。`rootDir: "."` 将源码输出到 `dist/src/`，脚本输出到 `dist/scripts/`；构建另复制 Python 脚本和 assets。不得为新功能顺手改成 `dist/index.js` 或改变产物目录。
- server 日常命令：`pnpm dev`、`pnpm build`、`pnpm start`（`node dist/src/index.js`）。构建后需重启实际服务进程才生效。
- desktop 的 `pnpm build` 包含 main 与 renderer 类型检查、Vite 打包及 preload 复制；`pnpm package:win` / `pnpm package:mac` 输出到 `apps/desktop/release/`。跨系统打包与目标系统运行验收分别报告。

## 桌面界面与交互

- 优先使用 **Arco Design** 现有组件与图标，定制布局使用局部样式；保持紧凑、一致的视觉和反馈，不随意引入其他 UI 框架。
- 聊天交互参照飞书，遵守[群聊规格](product-spec/chat/README.md)及[窗口/设置规格](product-spec/desktop/README.md)，兼顾窄窗口、键盘操作与 macOS 原生行为。
- main、preload、renderer、shared 保持清晰边界；共享层不依赖进程实现。IPC 使用固定能力、明确类型与来源校验，不暴露任意系统调用。
- 聊天历史、草稿和图片仅用有界内存缓存；暂停收取、隐藏窗口与退出登录是不同生命周期，不能复用销毁逻辑导致数据丢失。

## 服务端实现约定

- 保持 TypeScript strict，不新增 `any` 逃逸；匹配邻近代码的 2 空格、单引号、分号风格。server 与 Electron main 使用 NodeNext，相对导入带 `.js`；renderer 遵循其 Bundler 配置。
- 新增环境变量统一 `DOGEBOT_` 前缀，按语义分组并标明单位（`_SECONDS`、`_MS`、`_HOURS` 等）。集中在 [config.ts](apps/server/src/config.ts) 解析，复用正整数、正小数、概率、布尔等解析器，不在业务中裸转数值；同步 README 与对应产品规格。
- SQLite schema 和迁移集中在 [db.ts](apps/server/src/db.ts)，迁移幂等，兼容旧库；SQL 参数化。软删除保留 `status` / `deleted_at` 语义，活跃查询复用共享过滤条件。
- 抖音检测只从 `checkDouyinAwemeValidityCached` 进入，复用缓存、统一频控及同 key 在途去重；命中缓存不入队。网络错误、超时、队列满为不确定（`errored: true, valid: true`），不得据此删记录或跳过数据。阶段、标题标记及管理员确认约束见[检测规格](product-spec/douyin/validity-checks.md)。
- CPU/子进程任务复用 [concurrency.ts](apps/server/src/utils/concurrency.ts) 的并发、队列和超时机制，不新增无界任务堆积。
- 每个启用 bot 独立长连接并在启动时恢复；命令解析集中在 `feishu/commands/parsers.ts`。管理员通知失败需捕获并记录，不能中断主流程。
- 沿用结构化日志：`console.error('[模块] 事件', { 关键字段, error: error instanceof Error ? error.message : String(error) })`。

## 验证与提交

- 改 server 代码后必须通过 `cd apps/server && npx tsc -p tsconfig.json --noEmit`；涉及产物时执行该应用 `pnpm build`。改 desktop 代码后执行 `apps/desktop` 内的 `pnpm build`。
- 回归验证统一使用 Vitest，分别进入各应用运行 `pnpm test`（包含测试及相关源码类型检查）；贴纸 HDR 可单独运行 server 的 `pnpm test:sticker-hdr`。复用已有场景，按改动范围补充缓存、组件或模拟接口测试，不重复维护独立验证脚本。
- 纯文档改动检查路径、链接和描述一致性即可。验证结论写明模拟/真实环境及平台，未实测内容如实说明。
- 保留工作区已有改动，不夹带无关重构、生成产物、敏感配置或全仓换行符变化。
- 使用 Conventional Commits，如 `feat(chat): ...`、`fix(desktop): ...`；**仅在用户明确要求时提交或推送**，提交只包含当前授权范围。
