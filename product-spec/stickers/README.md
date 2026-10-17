# 风格贴纸与 HDR

## 功能与入口

把文案渲染为「字节范」或「勇攀高峰」风格图片，供飞书发送与公开 HTTP 获取。desktop 当前没有独立贴纸编辑器。

| 入口 | 交互 |
| --- | --- |
| `/byte-style 文案` / `/字节范 文案` | 立即生成字节范图片 |
| `/scale-new-heights 文案` / `/勇攀高峰 文案` | 立即生成勇攀高峰图片 |
| 不带文案的命令 | 非话题消息引用了文字时直接使用引用文字；其他情况打开交互生成卡片 |
| 普通文本随机生图 | 遵循会话开关、概率及长度阈值，见[被动互动](../bot-interactions/passive.md) |
| `/open-api/v1/byte-style` / `/open-api/v1/scale-new-heights` | 无需登录的 GET 图片接口，必须提供 `text`，支持颜色、缩放、渐变角度及 EV |

## 卡片设计

卡片提供预览、文案、两种常用色选择、自定义 `#RRGGBB`、渐变角度和 HDR EV。

- 初始预览可使用随机配色和角度；自定义有效颜色优先于预设选择。
- 「预览」使用当前表单更新卡片，不向会话额外发送成品；HDR 入口更新卡片及对应链接。
- 「发送」尝试撤回生成卡片，并把生成图片回复到触发卡片的原消息，保留其话题关系；「撤回」只撤回卡片。
- 命令在话题内带文案生图时直接回复话题；不因改用卡片编辑而丢失原消息目标。
- 失败记录对应 bot、卡片与动作，不把未完成操作显示为成功；卡片按钮依赖飞书事件配置，desktop 只显示其摘要。

## 输入、HDR 与资源限制

- 文案绝对处理上限默认 150 字符；手动命令和 OpenAPI 超长输入截断。随机生图默认最大 10 字符，可通过会话 `--max` 调整，但不超过绝对上限。
- HTTP 参数：`text`、`color1`、`color2`、`scale`、`gradientAngle`（兼容 `ga`）、`ev`。缺失文案返回 400；渲染失败返回错误，不返回空白成功图。
- `ev` 只在 `0 < ev <= 5` 时启用 HDR，支持小数；省略、非法或越界时返回普通 PNG。卡片非法 EV 回落为 4，输入显示与 HDR 链接保持一致。
- HTTP 返回实际图片 MIME 及颜色、角度、倍率等响应头；HDR 显示效果还取决于查看端支持。普通飞书预览不能代表 HDR 链接效果。
- HTTP、飞书命令、随机生图和卡片共用渲染限流：默认并发 2、等待队列 20、任务超时 20 秒；内部结果缓存默认 60 秒、最多 20 项。
- 默认使用 `@syru/byted-sticker-generator`，字体随 assets 部署；保留环境变量切换旧渲染管线的兼容入口。渲染参数以 `config.ts` 为准，注意与上游包默认值的区别。

验收关注：两风格及中英文、引用/话题目标、颜色覆盖、卡片预览与发送、EV 边界与图片元数据、无文案错误、并发与超时。已有 `pnpm test:sticker-hdr` 检查 HDR 边界和卡片一致性。

代码：[HTTP 与渲染](../../apps/server/src/styleStickers.ts)、[配置](../../apps/server/src/config.ts)、[卡片](../../apps/server/src/feishu/cards/style-sticker-card.ts)、[动作](../../apps/server/src/feishu/card-action.ts)、[HDR 验证](../../apps/server/tests/style-sticker-hdr.test.ts)。
