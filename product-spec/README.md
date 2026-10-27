# DogeBot 产品规格

本目录按用户功能组织当前产品规格，作为需求讨论、实现和验收的共同入口。首次整理日期：2026-10-17，代码基线：`9891c08`。

## 模块导航

| 一级目录 | 功能与规格 | 主要代码位置 |
| --- | --- | --- |
| [account](account/README.md) | 服务端登录、账号隔离、会话生命周期 | server `auth.ts`；desktop 登录页 |
| [feishu-bots](feishu-bots/README.md) | 机器人绑定、扫码创建、连接与管理员 | server `feishu/`；desktop 机器人页 |
| [chat](chat/README.md) | 群聊、历史、话题、发送、撤回 | server `feishu/chat/`；desktop `feishu/chat/` |
| [douyin](douyin/README.md) | 收藏监听、内容库、分发、有效性检测 | desktop `main/douyin/`；server `douyin*` |
| [bot-interactions](bot-interactions/README.md) | 飞书命令、个人 @ 名单与确认复制、会话配置、定时任务、被动互动 | server `feishu/commands/`、`passive/`、`cards/` |
| [stickers](stickers/README.md) | 字节范与勇攀高峰贴纸、交互卡片、HDR | server `styleStickers.ts`、`cards/style-sticker-card.ts` |
| [desktop](desktop/README.md) | 工作区、窗口、托盘、设备设置 | desktop `main/`、`renderer/App.tsx` |

常用细分规格：[消息收取](chat/message-receiving.md)、[聊天数据生命周期](chat/data-lifecycle.md)、[抖音监听](douyin/monitor.md)、[抖音分发](douyin/library-and-delivery.md)、[抖音检测](douyin/validity-checks.md)、[被动互动](bot-interactions/passive.md)、[桌面设置](desktop/settings.md)。

## 产品边界

- desktop 是操作入口；server 承担账号、业务持久化、飞书凭证和机器人长连接。两者是独立 pnpm 应用，当前没有 CLI 应用。
- 群聊始终以所选机器人身份交互。聊天历史由飞书保存，server 主动代理查询并转发实时事件，desktop 仅使用有界内存缓存。
- 抖音收藏、订阅、机器人命令配置是持久化业务数据；不能将聊天历史不落盘的约束扩大为整个产品不保存数据。
- 桌面收取策略只控制 desktop 的聊天读取与 SSE；server 机器人命令、定时任务和通知继续独立运行。

## 文档约定

- **`product-spec/`** 维护当前功能、交互、默认值、异常反馈及能力边界，不堆叠开发过程记录。跨模块行为由所属模块维护，其他模块链接引用。
- **`docs/YYYY-MM-DD/`** 保存调研、方案、取舍与实施记录。日期使用北京时间；已有方案保留历史语境，实施后注明状态并链接对应规格。
- **README / 架构文档** 记录安装、运行、部署、接口和代码结构；产品规则通过本目录导航查阅。
- 改动功能前先阅读对应规格；改动后同步更新行为、默认值、限制及必要的验收场景。新模块创建一级目录和入口文档，并更新本表。
- 本轮文档描述代码中已有能力；“待验证”不等于“未实现”。计划中的能力必须明确标注，不能写成已交付承诺。发现代码与规格不一致时，先确认差异与预期，再同步修正。

## 验证范围

聊天与收取策略已有构建、模拟接口、缓存和交互检查，以及 WSLg/Linux Electron 窗口验证，详见[实现记录](../docs/2026-10-17/feishu-chat-receive-policy-plan.md#8-实现与验证记录)。真实飞书租户及 Windows/macOS 的原生行为仍需对应环境验收。其他模块本轮依据源码整理，没有重新进行端到端验证。

「从不自动收取」的构建、模拟请求与交互、Linux Electron 检查见[手动收取验证记录](../docs/2026-10-17/feishu-chat-manual-receive-plan.md#实现与验证记录)。

聊天缓存、编辑状态与 Vitest 回归的本轮修复及验证范围见[审查修复记录](../docs/2026-10-17/chat-review-fixes-and-vitest.md)。

开发规范见 [AGENTS.md](../AGENTS.md)；详细接口与部署见 [server README](../apps/server/README.md)，桌面使用与打包见 [desktop README](../apps/desktop/README.md)。
