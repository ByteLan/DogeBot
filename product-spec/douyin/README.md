# 抖音收藏与分发

## 功能链路

desktop 使用本机抖音登录态运行收藏监听任务，从匹配接口提取视频 ID，按 `clickText` 同步 server；server 去重入库，供机器人随机发送、标题搜索、定时任务、会话订阅及公开随机视频接口使用。

| 规格 | 内容 |
| --- | --- |
| [monitor.md](monitor.md) | 多任务、浏览器身份、调度与捕获交互 |
| [library-and-delivery.md](library-and-delivery.md) | 入库归属、去重、抽取、搜索、订阅与公开接口 |
| [validity-checks.md](validity-checks.md) | 有效/失效/不确定判定、频控、管理员确认与软删除 |

## 共同边界

- 监听由本机 Electron 执行，依赖本机登录态、抖音页面和接口；server 不代替 desktop 登录或浏览收藏页面。
- `clickText` 是内容分组名，同时可作为页面点击文案。任务 ID、浏览器身份、收藏页地址及请求筛选均不是订阅键。
- 收藏视频 ID、标题检查结果和订阅配置是持久化业务数据；与聊天历史仅存内存的设计分开。
- 退出程序后本机监控停止；已入库内容、server 定时任务与订阅配置保留。切换 desktop Tab 或暂停聊天收取不会停止抖音任务。
- 检测异常不能导致删记录或判无效；疑似失效需要按确认流程处理。

代码入口：[desktop 监控](../../apps/desktop/src/main/douyin/monitor.ts)、[入库与查询](../../apps/server/src/douyin.ts)、[机器人分发](../../apps/server/src/feishu/commands/douyin.ts)。
