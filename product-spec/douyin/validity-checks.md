# 视频有效性与管理员确认

## 判定规则

检测区分“有效”“疑似失效”“不确定”。网络异常、超时、队列满和无法判断一律为不确定（`errored: true, valid: true`），不能据此删除记录或跳过分发。检测链路和抖音非官方接口可能变化，结果不是对第三方内容永久可用的保证。

默认启用两阶段：

1. 移动分享页的真实标题可快速判有效；裸“抖音”等兜底标题只表示需继续确认。
2. Web 详情 API 以非空 `aweme_detail` 判有效、取标题；明确为空判失效。依赖惰性缓存的 `ttwid`，接口受限或解析失败回落不确定。

两阶段均可通过配置关闭；显式关闭阶段 2 时，阶段 1 的兜底标题沿用旧的失效判定。因此默认两阶段的规则不能直接套用于关闭阶段 2 的部署。

## 触发与确认

- 随机分发、搜索、订阅、定时和公开接口复用统一检测。缓存命中直接返回，冷请求排队并按视频 ID 合并在途检测。
- 收到包含「视频无效」「视频失效」的消息时，从当前消息或引用提取视频 ID，反馈检测结果；疑似失效通知 bot 的 `/set-default` 管理员私聊确认。
- 通知携带链接、视频 ID、标题、触发会话/用户、来源及阶段检测过程。管理员确认卡片可取消或删除；恢复入口按卡片类型提供。未经确认不得将检测结果直接变成删除动作。
- `/douyin --delete` 也需管理员身份与确认卡片；操作仅影响绑定用户的记录。删除使用软删除，取消不改变库存，卡片处理后更新/撤回反馈。
- 管理员通知失败必须记录错误，不能中断主要入库或分发流程。未配置管理员不代表可以省略确认而自动删除。

## 默认频控

| 环境变量 | 默认值 | 语义 |
| --- | --- | --- |
| `DOGEBOT_DOUYIN_CHECK_CONCURRENCY` | `1` | 全局检测并发 |
| `DOGEBOT_DOUYIN_CHECK_QPS` | `1` | 每秒放行次数，允许正小数 |
| `DOGEBOT_DOUYIN_CHECK_QUEUE_MAX` | `0` | 等待队列上限，0 为不限；超限回落不确定 |
| `DOGEBOT_DOUYIN_CHECK_CACHE_HOURS` | `24` | 标题结果新鲜期，小时，允许正小数 |
| `DOGEBOT_DOUYIN_OPEN_API_CACHE_SECONDS` | `2` | 公开抽取结果缓存，秒，允许正小数 |
| `DOGEBOT_DOUYIN_CHECK_STAGE1_ENABLED` | `true` | 分享页阶段 |
| `DOGEBOT_DOUYIN_CHECK_STAGE2_ENABLED` | `true` | 详情 API 阶段 |

## 实现约束与验收

业务入口只调用 `checkDouyinAwemeValidityCached`，由其使用队列和唯一网络检测函数 `checkDouyinAwemeValidity`。缓存中有效标题不能以 `INVALID_TITLE_MARKER` 开头，确认失效标题必须带该前缀；管理员卡片保留 `stages`/`decidedBy` 渲染的检测过程。不得新增旁路请求破坏频控、去重和失败保护。

验收关注：真实/兜底标题分支、详情空值与异常区分、阶段开关、缓存和同 ID 合并、频控队列满、检测失败不删数据、非管理员按钮无权修改、取消/删除/恢复结果。

代码：[检测](../../apps/server/src/douyin-check.ts)、[队列](../../apps/server/src/douyin-check-queue.ts)、[统一入口与软删除](../../apps/server/src/douyin.ts)、[管理员卡片](../../apps/server/src/feishu/cards/douyin-invalid-card.ts)、[按钮处理](../../apps/server/src/feishu/card-action.ts)。
