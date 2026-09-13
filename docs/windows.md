# Windows 原生适配与上游同步

本 Fork 的 Windows 维护分支是 `codex/windows`，`master` 只跟踪
[deepcoldy/botmux](https://github.com/deepcoldy/botmux) 的上游提交。

## 当前阶段

已加入原生 Windows 源码构建、Windows PATH/PATHEXT 查找、ConPTY 启动和
Codex / Claude Code 共用的启动处理。Windows 默认使用 PTY，Linux/macOS 仍默认
使用 tmux；显式的环境变量和机器人后端配置优先。

支持原生 `.exe` / `.com` 和标准 npm 生成的 Node.js `.cmd` 启动器。npm 启动器
被解析为 Node + JavaScript 入口，不经 cmd.exe 拼接参数，避免中文、引号、百分号
和 shell 特殊字符被改写。自定义 `.bat` / `.cmd`、PowerShell 脚本启动器暂不支持；
可通过 `cliPathOverride` 指向原生可执行文件。

这是开发中的原生适配。已验证 **飞书私聊 → 原生 Codex CLI → 飞书文字回复**；
Claude Code 的飞书完整链路仍待验证。版本 smoke 不调用模型；输入 smoke 只检查
真实 Codex 输入框，不提交 prompt。
2026-09-13 本机 Claude Code 已登录，模型请求测试遇到服务端 HTTP 503，尚未取得成功响应。
Windows 上的完整单元测试套件、活跃 CLI 会话关闭时的进程清理、CLI hooks 和
会话恢复仍需继续验证。PTY 会话不跨 daemon 重启存活；tmux /adopt、Unix 文件沙盒、
Windows 单文件发行包和 Electron 安装包均不在本阶段支持范围。
原生 tmux 移植版需要另行验证 botmux 的 control-mode / pipe-pane / reattach 行为；
需要上游现有完整运行环境时使用 WSL2。

## 本地构建和验证

使用 Bun **1.4.2**（与上游一致）、Node **22.13+**，以及已安装的 Codex 和 Claude Code。
在普通 checkout 中执行，依赖目录不得链接到其它 checkout：

```powershell
bun install --frozen-lockfile
bun run build
bun run test -- test/windows-launch.test.ts test/executable.test.ts test/pty-backend-launch-shell.test.ts test/windows-stdin-encoding.test.ts test/backend-gate.test.ts
node --test test/sync-upstream.test.mjs
node scripts/smoke-windows-cli.mjs
node scripts/smoke-windows-codex-input.mjs
bun run windows:cli --help
```

Windows 运行时使用经过版本检查的 Node.js 入口 `bun run windows:cli <命令>`；
Bun 只负责包管理和构建。实际测试中 Bun 1.4.2 的 ConPTY 路径会使 Codex 提前退出，
因此本阶段不支持直接用 `bun dist/cli.js` 或 `daemon:bun` 运行 Windows 会话。
入口使用 Node 22.13+，确保 SQLite 引擎可用，并让后续 daemon/worker 使用同一个解释器。

本机已验证 Codex `0.142.5`、Claude Code `2.1.201` 的真实 `--version` 启动和正常退出。
实际模型调用使用 Codex `0.154.0`；旧的 `0.142.5` 调用 `gpt-6-astra` 时被服务端
拒绝并要求升级。可独立安装新 CLI，通过机器人 `cliPathOverride` 指向它。
版本检查、更新状态探测和 Codex 模型列表查询也复用同一 npm 启动器解析，
避免 Windows 的 `execFile` 直接运行 `.cmd` 时返回 `EINVAL`。smoke 同时检查
真实 CLI 的管道调用与 PTY 调用；FNM 的 POSIX 符号链接布局测试仅在 Linux 运行。

ConPTY 输入为 BMP Unicode 字符发送显式 Win32 Unicode 按键，保留中文弯引号、
破折号与箭头；连续字符发送按下/抬起事件，emoji 保留完整代理对。避免 native
Codex 丢弃部分字符后，历史记录与原消息不一致而触发 `submit_unconfirmed`。
Windows 会话提示使用 PowerShell 与 `botmux.cmd`，多行正文写 UTF-8 文件后发送。
Codex 标题读取/同步同样解析 npm 启动器；关闭辅助进程时等待 Windows 释放管道与
工作目录句柄，再清理临时目录。

Windows 的 supervisor 通过本地命令队列轮询处理单机器人操作，通过绑定 PID 和
启动时间的停止请求退出整组服务；自有 daemon/dashboard 子进程通过 Node IPC
执行清理。父进程丢失也会请求清理，启动中收到的请求会等清理处理器就绪再执行。
停止超时时保留 supervisor 并报错，避免强杀父进程后生成重复实例。
已在本机验证 `start`、`stop`、`restart`、`start-bot` 和 `stop-bot`，并确认
重启后 daemon/dashboard 在线、飞书长连接重新建立；这尚不代表活跃 CLI 会话已验收。

测试覆盖真实 PTY 输入/输出、窗口调整、退出清理、中文和特殊字符 argv、环境注入、
两种 CLI 的查找、POSIX 后端默认值，以及真实临时 Git 仓库中的同步/冲突/分叉。
Linux 的持续集成运行相同的跨平台用例；只有 Windows 专属用例在 Linux 上跳过。

## 自动同步

`Sync upstream` 工作流在每周一、周四北京时间 **09:17** 检查上游，也可以从
GitHub Actions 手动运行。GitHub 的定时执行可能延迟，公开仓库 60 天无活动可能停用。

1. 获取上游 `master`；只允许快进更新 Fork 的 `master`。
2. 把上游提交放入 `codex/sync-upstream`，创建或更新合入 `codex/windows` 的 PR。
3. 在同一次工作流中验证 PR 的合并结果，运行 Windows / Linux 构建和针对性的兼容测试。
4. 由维护者检查后使用 **Create a merge commit** 合并，保留上游提交的祖先关系。

不自动合并、不自动发布、不强推。上游无新提交时不重复创建 PR；相同同步 PR
没有变化时不重复测试。人工关闭的同一版本 PR 不会被重新创建；上游出现更新后
才允许新建。如果 `master` 或自动同步分支出现额外改动，工作流报错并保留现状。
合并冲突会保留在 PR 中，Windows 分支不会被覆盖。

同步 PR 的 `upstream-sync/compatibility` 状态关联当次 Windows 基线和上游版本，
具体基线 SHA 和验证工作流链接写在 PR 描述中。若基线随后改变，应重新运行同步
工作流再合并。兼容测试是本阶段的针对性检查，并不等同于上游全部测试或飞书实测。

本 Fork 默认分支必须是 `codex/windows`，使定时工作流生效。Actions 需要允许
工作流创建 PR；使用仓库自带 `GITHUB_TOKEN`，不需要存储个人访问令牌。
只有 `sync` 作业拥有内容/PR 写权限，运行项目代码的验证作业只有读取权限。
Fork 中已停用继承来的上游发布、npm dist-tag、文档发布和发布审批清理工作流；
这些文件仍保留，避免同步时产生不必要差异。

## 日常开发

从 `codex/windows` 新建 `codex/windows-*` 功能分支，再通过 PR 合回。
不要在 `master` 修改文件，也不要 squash 同步 PR，否则 Git 无法保留上游祖先关系。
普通提交不发布软件；Windows 的正式发布流程待完整运行链路验证后再建立。
