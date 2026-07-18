# /douyin --delete 确认卡片 + 抖音卡片删除/恢复状态机

## Context（背景）

当前 `/douyin --delete` 的行为有两处不足，需要改造：

1. **aweme_id 只能内联识别**：`parseDouyinCommand` 只从 `--delete` 后紧跟的参数里取 aweme_id（`douyin.ts` 正则 `^\d{6,}$`），无法从消息末尾数字或引用消息里识别。
2. **删除是"即时且无确认"的**：命令解析成功后，`commands/index.ts` 直接调用 `softDeleteDouyinAwemeRecords` 硬性软删，没有确认环节，也无法撤销。

同时，现有两张抖音管理卡片（失效检测卡片 `buildDouyinInvalidCard`、有效/异常结果卡片 `buildDouyinResultCard`，见 [douyin-invalid-card.ts](file:///Users/bytedance/DogeBot/apps/server/src/feishu/cards/douyin-invalid-card.ts)）点击「删除」后是**撤回卡片**，无法看到删除结果、也无法恢复。

**目标**：
- `/douyin --delete` 支持从「当前消息最后一串 ≥10 位数字」识别 aweme_id，找不到则从「引用消息最后一串 ≥10 位数字」识别；识别成功后不再直接删除，而是通过 `reply_in_thread` 回复一张确认卡片。
- 统一改造**全部三种抖音卡片**（失效检测、有效/异常结果、新增的 --delete 确认）为同一套删除/恢复状态机：
  - 「取消」按钮改名为「撤回」，点击后撤回卡片（行为不变）。
  - 「删除」点击后**不撤回**卡片，而是就地更新卡片：文案改为"已删除"，「删除」按钮替换为「恢复」。
  - 「恢复」点击后把 DB 记录置回未删除，卡片再次更新，「恢复」按钮又变回「删除」（可反复切换）。
- 权限：`/douyin --delete` 指令**维持只有 `/set-default` 管理员可触发**；三种卡片的按钮**只有该 bot 管理员可点击**（沿用现有 `operatorId === adminUserId` 服务端校验，非管理员点击直接忽略）。

## 关键改动文件

### 1. DB 层：新增恢复函数 — [douyin.ts](file:///Users/bytedance/DogeBot/apps/server/src/douyin.ts)
新增 `restoreDouyinAwemeRecords(userId, awemeId)`，与现有 `softDeleteDouyinAwemeRecords`（L149-161）对称：
- 统计 `matched`（该 user_id + aweme_id 的总记录数）。
- `UPDATE ... SET status = '', deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND aweme_id = ? AND status = 'delete'`，返回 `{ matched, restored: result.changes }`。

### 2. douyin-guard.ts — 共享 aweme_id 解析 + 恢复导出 — [douyin-guard.ts](file:///Users/bytedance/DogeBot/apps/server/src/feishu/douyin-guard.ts)
- 新增 `export function softRestoreAweme(userId, awemeId)`，包装上面的 `restoreDouyinAwemeRecords`（与 `softDeleteAweme` L160-162 对称）。
- 新增 `export async function resolveAwemeIdFromMessage(bot, message, currentText)`：先 `extractAwemeIdFromText(currentText)`（复用 [douyin-check.ts](file:///Users/bytedance/DogeBot/apps/server/src/douyin-check.ts#L68-72) 的 `\d{10,}` 取最后一段），找不到则遍历 `referencedMessageIds(message)`（[message-parser.ts](file:///Users/bytedance/DogeBot/apps/server/src/feishu/message-parser.ts#L219)），`fetchMessageById` + `parseFeishuMessage(...).text` 再取。逻辑等同 message-handler 里私有的 `resolveReportedAwemeId`（[message-handler.ts](file:///Users/bytedance/DogeBot/apps/server/src/feishu/message-handler.ts#L32-43)）。
- 说明：需在 douyin-guard 里 import `fetchMessageById`（`./api.js`）与 `parseFeishuMessage`、`referencedMessageIds`（`./message-parser.js`）；这两个模块都不反向依赖 douyin-guard，无循环。
- 把 message-handler 的 `resolveReportedAwemeId` 改为直接调用 `resolveAwemeIdFromMessage`，消除重复。

### 3. 卡片：统一状态机 — [douyin-invalid-card.ts](file:///Users/bytedance/DogeBot/apps/server/src/feishu/cards/douyin-invalid-card.ts)
把三种卡片合并为一套「context + state」渲染，复用同一 `DOUYIN_INVALID_CARD_KIND` 与按钮组：
- **action 类型**扩展为 `'delete' | 'cancel' | 'restore'`；`isDouyinInvalidCardAction` 同步接受 `'restore'`。
- **统一 context** 增加 `variant: 'invalid' | 'valid' | 'errored' | 'command'`（决定 confirm 态标题/文案）。原 `DouyinInvalidCardContext` 与 `DouyinResultCardContext` 合并/复用，携带 `awemeId/userId/adminUserId/title/triggerChatId/triggerPersonId/triggerPersonName/source/variant`。
- **按钮组** `actionButtonColumns(context, state)`：左键恒为「撤回」(action=`cancel`, `default`)；右键按 `state` 切换：`confirm` → 「删除」(action=`delete`, `danger_filled`)，`deleted` → 「恢复」(action=`restore`, `default`/`primary`)。
- **callback value** 必须携带重建卡片所需的**全部** context 字段（awemeId、userId、adminUserId、variant、title、triggerChatId、triggerPersonId、triggerPersonName、source），因为 `restore/delete` 后要在 handler 里 `updateInteractiveMessage` 重绘另一状态。
- 新增 `renderDouyinCardState(context, state)`：
  - `state==='deleted'` → 标题 `**🗑️ 已删除该抖音收藏记录**`，尾行提示"已标记为删除，可点击「恢复」撤销，或「撤回」关闭本卡片。"
  - `state==='confirm'` → 按 `variant` 复用现有标题/尾行文案（invalid 的 ⚠️、valid 的 ✅、errored 的 ❔、command 的新确认文案）。
- 保留 `notifyAdminDouyinInvalid` / `notifyAdminDouyinResult`（改为传 `variant` 并用统一渲染，初始 `state='confirm'`）。
- 新增 `buildDouyinDeleteConfirmCard(context)` = 统一渲染 `variant='command', state='confirm'`；供 `/douyin --delete` 使用。

### 4. card-action.ts — 处理 delete/restore/cancel — [card-action.ts](file:///Users/bytedance/DogeBot/apps/server/src/feishu/card-action.ts#L172-255)
- `parseDouyinInvalidCardActionPayload` 解析出扩展后的全部 context 字段。
- 权限校验保持：`operatorId !== adminUserId` 直接 return（"只有管理员可点击"）。
- 分支：
  - `action==='delete'`：`softDeleteAweme` → `updateInteractiveMessage` 重绘 `state='deleted'`（**不再 deleteMessage**）。
  - `action==='restore'`：`softRestoreAweme` → `updateInteractiveMessage` 重绘 `state='confirm'`。
  - `action==='cancel'`（撤回）：`deleteMessage` 撤回卡片（沿用现逻辑）。
- import 增加 `softRestoreAweme`、`updateInteractiveMessage`（已引入）、统一渲染函数。

### 5. 解析器 — [parsers.ts](file:///Users/bytedance/DogeBot/apps/server/src/feishu/commands/parsers.ts#L36-114)
`parseDouyinCommand`：`--delete` 改为**裸标志**，不再要求内联 id。`shouldDelete` 保留；`deleteAwemeId` 恒为 `''`、`hasInvalidDelete` 恒为 `false`（id 改由消息/引用解析），clickText 剥离逻辑不变。冲突检测（`--delete/--subscribe/--unsubscribe` 互斥）保留。（`types.ts` 的 `DouyinCommand` 字段保持不变，避免类型连锁改动。）

### 6. 命令分发 — [commands/index.ts](file:///Users/bytedance/DogeBot/apps/server/src/feishu/commands/index.ts#L404-437)
`shouldDelete` 分支改造：
- 保留三层管理员校验（识别发送者 / 已设管理员 / 发送者==管理员）。
- 用 `resolveAwemeIdFromMessage(bot, message, text)` 解析 aweme_id；解析不到 → 回复用法："`/douyin --delete` 需要在消息里或引用消息里包含一串 ≥10 位数字的 aweme_id"。
- `bot.user_id == null` 校验保留。
- **不再直接 `softDeleteDouyinAwemeRecords`**；改为 `replyCard(bot, messageId, buildDouyinDeleteConfirmCard(context), true)`（reply_in_thread），context 携带 `adminUserId = getDefaultCommandRecord(bot.id).adminUserId`、`userId = bot.user_id`、`variant='command'`、trigger 信息。
- 移除现无用的 `softDeleteDouyinAwemeRecords` 直接 import（若无其它引用）。

## 权限点击说明
飞书 2.0 卡片没有简单的"按 open_id 限制点击"字段，因此"只有管理员可点击"沿用**服务端 operator 校验**：卡片 callback 到达 `handleFeishuCardAction` 后，比对 `operatorId === adminUserId`，非管理员点击被忽略（不改 DB、不改卡片）。此逻辑三种卡片共用（同一 kind）。

## 验证（端到端）
1. 构建：`cd /Users/bytedance/DogeBot/apps/server && npx tsc --noEmit`（或项目既有 build 脚本）确认无类型错误。
2. 管理员在群里 @bot 发 `/douyin --delete`，消息里带一串 19 位 aweme_id → 收到 reply_in_thread 确认卡片（[撤回][删除]）。
3. 引用一条含 aweme_id 的消息，只发 `/douyin --delete`（无数字）→ 能从引用消息识别并弹卡片。
4. 点「删除」→ 卡片就地变为"🗑️ 已删除…"，右键变「恢复」；查 DB `status='delete'`。
5. 点「恢复」→ 卡片变回 confirm 态，右键变「删除」；查 DB `status=''`、`deleted_at=NULL`。
6. 点「撤回」→ 卡片被撤回。
7. 非管理员点击任意按钮 → 无反应，DB/卡片不变。
8. 触发一次"视频无效"关键词上报，验证失效/有效结果卡片也走同一套删除/恢复/撤回行为。
