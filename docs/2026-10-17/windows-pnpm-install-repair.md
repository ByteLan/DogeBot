# Windows desktop 依赖安装修复

状态：已修复，原生 Windows 安装与回归验证通过。对应[桌面规格](../../product-spec/desktop/README.md)和[安装说明](../../apps/desktop/README.md)。

## 已确认原因与方案

- Windows 在 `node_modules/.ignored/@vitejs/plugin-react` 执行 unlink 返回 EPERM；该项是 WSL 可见的损坏软链接。
- 上一轮在 Windows 工作副本内直接用 WSL 安装了 Linux 依赖，混用了两个系统的 `node_modules`。将 desktop 混用目录暂移到 `.windows-dependency-repair/node_modules`，从 Windows 原生环境重新安装，验证完成后清理旧目录。
- Windows 全局 pnpm 为 8.15.8，仓库 `packageManager` 声明 11.3.0；对齐 pnpm 版本，保留当前 Node.js 和其他全局工具配置。
- pnpm 11 检查发现新加入的 3 个间接依赖不满足现有 minimumReleaseAge 策略。使用 pnpm 11 得到符合策略的解析结果，并将修正范围收敛为 `@asamuzakjp/css-color` 7.1.7 → 7.1.6、`@asamuzakjp/dom-selector` 10.0.4 → 10.0.3、`asn1js` 3.1.0 → 3.0.10。其他直接/间接依赖版本和完整性保持不变；完整 frozen-lockfile 安装通过，不放宽该策略。
- 后续 WSL 验证使用 Linux 文件系统内的独立副本；Windows 工作副本的依赖只由 Windows Node/pnpm 创建。

## 验证记录

运行环境：原生 Windows Node.js 22.22.3、pnpm 11.3.0。命令由 Windows `cmd.exe` / `pnpm.cmd` 执行，没有用 WSL pnpm 写入新的依赖目录。

| 检查 | 结果 |
| --- | --- |
| `pnpm.cmd install --frozen-lockfile` | 通过；Electron、electron-winstaller、esbuild 安装脚本成功 |
| 再次 `pnpm.cmd install --frozen-lockfile` | 通过，`Already up to date`，不再出现 EPERM |
| `pnpm.cmd test` | 类型检查及 31 项 desktop Vitest 回归全部通过 |
| `pnpm.cmd build` | 主进程/renderer 类型检查、Vite 打包与 preload 复制全部通过 |
| 依赖来源与链接 | `.modules.yaml` 记录 Windows pnpm store，React 链接为 Windows Junction，原报错路径已移除 |

测试仍有 React 19 ref/重复 key 提示，构建保留大 bundle 提示；本轮没有修改相关界面实现。未执行 Electron 窗口交互或真实飞书租户验收，也未重新验证 server。Windows Node.js 版本未改变，本记录不改变 server 需要 Node.js 24+ 的要求。

改动范围为 desktop 的 3 个间接依赖锁定版本、安装说明及本记录，另将 Windows 全局 pnpm 从 8.15.8 对齐为仓库声明的 11.3.0。源码及已有未提交改动保留；此次不提交或推送。
