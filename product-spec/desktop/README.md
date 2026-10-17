# 桌面工作区与窗口

## 导航与视觉

登录后使用左侧垂直导航，顺序为「机器人 → 群聊 → 抖音监控 → 设置」，退出登录放在导航底部。不同工作区共享标题栏，不再使用顶部三 Tab 布局。设置入口位于抖音监控下方。

UI 优先复用 Arco Design 组件与图标，保持紧凑间距、明确层级和统一状态反馈；聊天布局及交互参照飞书。业务定制通过组合组件与局部样式实现，避免同类控件出现多套视觉规则。

默认主窗口为 960 × 720，最小 640 × 480；较窄窗口下设置项可换行，话题覆盖会话右侧。正文与长列表在自身区域滚动，不能因长群名、动作栏或设置选项造成整体横向溢出。

## 平台窗口规则

| 平台 | 标题栏与窗口按钮 | 最小化 / 关闭 |
| --- | --- | --- |
| Windows / Linux | 去除原生菜单及标题栏，32px 自定义标题栏，右上角最小化、最大化/还原、关闭；窗口按钮无 tooltip，保留无障碍名称 | 最小化与关闭都隐藏到托盘 |
| macOS | 隐藏式标题栏，左上角保留原生红黄绿按钮并预留空间；系统菜单保留应用、编辑、窗口及标准快捷键 | 黄色按钮最小化到 Dock；关闭隐藏；绿色保留系统全屏 |

顶部空白区域可拖动；双击遵循平台窗口行为。点击托盘或 macOS Dock 恢复主窗口；真正退出通过托盘「退出」或 macOS 应用菜单。`F12` 可打开开发者工具。

关闭隐藏不是退出：聊天内存和抖音任务仍存在，聊天是否继续收取取决于[消息收取设置](../chat/message-receiving.md)。真正退出结束本机任务，但云端机器人业务继续由 server 执行。

## 运行与验收

desktop 包含 main、preload、renderer、shared 四层；渲染页面通过固定桥接调用窗口、系统设置和监控能力。窗口/设置 IPC 只允许本地应用主窗口调用，避免远程抖音页面调用系统控制。

打包入口为应用目录内的 `pnpm package:win` / `pnpm package:mac`，产物输出 `apps/desktop/release/`。打包完成不代表在目标系统验收通过；当前版本没有自动更新产品流程。

验收关注：四工作区与登录页的一致标题栏、窄窗口、无 tooltip 的窗口按钮、Win/Linux 托盘、macOS 原生按钮及 Dock、退出与隐藏的数据生命周期差异。

相关：[设置规格](settings.md)、[架构说明](../../apps/desktop/docs/architecture.md)、[使用与打包](../../apps/desktop/README.md)。代码：[工作区](../../apps/desktop/src/renderer/App.tsx)、[窗口](../../apps/desktop/src/main/main-window.ts)、[生命周期与菜单](../../apps/desktop/src/main/index.ts)、[托盘](../../apps/desktop/src/main/tray.ts)、[标题栏](../../apps/desktop/src/renderer/components/WindowChrome.tsx)。
