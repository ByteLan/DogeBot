# 内容库、搜索与分发

## 入库和归属

desktop 向 `POST /api/douyin/aweme-records` 提交 `{ clickText, awemeIds }`。server 按 `(user_id, click_text, aweme_id)` 去重，返回新增数和分组总数；重复上传不产生新增通知。视频正文文件不由该链路下载或存储。

记录采用软删除；活跃抽取和搜索排除 `status = 'delete'`。再次上传相同 ID 不等于自动恢复软删除记录。标题来自有效性检测缓存，搜索覆盖已取得可用标题的库存，不是实时搜索抖音全站。

## 飞书交互

命令在私聊或群内 @ 当前机器人后使用，读取该机器人绑定 DogeBot 用户的库存。

| 入口 | 产品行为 |
| --- | --- |
| `/douyin {分组} [--count n]` | 从指定 `clickText` 分组随机返回视频链接，无记录时明确提示 |
| `/douyin {分组} --search {关键词}` | 对缓存标题分词并按匹配分数返回结果，默认最多 2 条；无词或无命中回落随机抽取 |
| `/douyin {分组} --search-random {关键词}` | 使用同一搜索逻辑，从高分候选池随机抽取；同样支持回落 |
| `/douyin --subscribe {分组}` | 当前 bot + 当前群/单聊 + `clickText` 建立订阅，只推送后续真正新增入库的视频，不补发库存 |
| `/douyin --unsubscribe {分组}` | 取消当前会话对应订阅；不删除视频或桌面任务 |
| `/douyin --delete ...` | 管理员请求删除当前消息或引用中的视频 ID，先出确认卡片，确认后软删除，见[检测与确认](validity-checks.md) |

订阅不接受 `--count`，删除/订阅/取消/搜索等互斥动作冲突时给出用法提示。默认兜底以 `--search` 或 `--search-random` 结尾时，普通文本可附加为搜索词；定时分发见[机器人互动](../bot-interactions/README.md)。

发送前统一执行[有效性检测](validity-checks.md)。常规随机抽取可在疑似失效时重新选取，最多 5 次；订阅只针对本次新增项，不因失效抽取历史库存补发。通知失败不能回滚已成功入库的数据，不提供可靠消息队列或离线补发保证。

## 公开随机视频接口

- `GET /open-api/v1/mm` 返回 `{ data: { url, title } }`；`GET /open-api/v1/mm/redirect` 重定向至视频页；无候选时返回 404。
- 当前这两个接口无需登录，固定从全局 `随机甜妹` 分组取样；与按用户隔离的登录后命令接口不同。
- 两接口共享抽取结果短缓存，默认 2 秒，并合并在途请求；失效重抽最多 3 次。缓存窗口内可能返回同一视频，不保证每次结果不同。

验收关注：重复入库无重复通知、用户/分组隔离、标题搜索回落、订阅不补库存、软删除不复活、分发失败不回滚入库、公开接口共享缓存。

代码：[内容库及 OpenAPI](../../apps/server/src/douyin.ts)、[命令分支](../../apps/server/src/feishu/commands/index.ts)、[订阅与通知](../../apps/server/src/feishu/commands/douyin.ts)、[发送前检测](../../apps/server/src/feishu/douyin-guard.ts)。
