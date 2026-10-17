# 飞书机器人管理

## 功能与入口

desktop 左侧「机器人」管理当前账号的多个 bot，支持飞书与 Lark。机器人列表展示本地名称、应用信息、连接状态与管理员状态，提供探测、清除管理员、删除等操作。

| 绑定方式 | 用户流程与边界 |
| --- | --- |
| 手动绑定 | 输入名称、App ID、App Secret、域名；可选 Verification Token / Encrypt Key。已有应用需自行完成开放平台机器人能力、权限、事件订阅及发布配置 |
| 扫码创建并绑定 | 选择域名，打开授权链接，客户端轮询；完成后 server 保存新应用并绑定当前用户。采用 PersonalAgent 注册模板，实际权限仍以创建结果和发布配置为准 |

## 产品规则

- 每个启用的 bot 有独立飞书长连接，server 启动后自动恢复；desktop 退出、切页或暂停聊天收取不停止这些连接。
- 探测用于获取/更新机器人名称与 open ID。探测成功不能替代“群历史、成员、发送等所有权限均可用”的判断；各操作仍需明确反馈权限或网络错误。
- 列表响应不回传 App Secret 等敏感凭证；后续飞书调用统一由 server 代理。
- 首次成功执行 `/set-default` 的飞书用户成为该 bot 的命令管理员。DogeBot 登录账号与飞书命令管理员是两个身份。
- 绑定所有者可从 desktop 清除管理员；保留默认指令，下一个成功执行 `/set-default` 的用户可成为新管理员。
- 删除的是 DogeBot 绑定：关闭对应长连接，删除相关兜底、定时、订阅及会话配置，并通知在线聊天客户端。它不等于删除飞书平台应用。
- 长连接为主事件入口，`/feishu/webhook/:id` 保留为备用回调；重复到达的事件应去重，不能重复触发业务动作。

## 状态与能力边界

群聊能力取决于机器人实际加入的群、应用已授权并发布的权限和 server 的在线状态。聊天产品边界见[群聊规格](../chat/README.md)，事件和权限配置见 [server README](../../apps/server/README.md)。当前没有机器人凭证编辑、用户身份授权聊天或跨账号共享机器人管理界面。

验收关注：两种绑定流程、取消/超时/失败提示、多 bot 连接隔离、删除后客户端释放会话、清除管理员后的重新认领。

代码：[绑定管理](../../apps/server/src/feishu/bot-management.ts)、[连接](../../apps/server/src/feishu/connection.ts)、[扫码](../../apps/server/src/feishu/onboard.ts)、[desktop 页面](../../apps/desktop/src/renderer/components/FeishuBotsCard.tsx)。
