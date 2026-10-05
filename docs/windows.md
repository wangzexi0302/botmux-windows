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
2026-10-06 Claude 服务仍返回 HTTP 503，可用分组的模型列表为空；按用户要求暂缓真实 Claude 验收。
已加入原生 Zellij 托管会话后端与 `/adopt`，详见下节。CLI hooks 与 Codex 会话恢复已验证；
全部上游功能及其它 CLI 的真实恢复仍未完成 Windows 验收。直接 PTY 会话不跨 daemon 重启存活；tmux /adopt、Unix 文件沙盒、
Windows 单文件发行包和 Electron 安装包均不在本阶段支持范围。
原生 tmux 移植版需要另行验证 botmux 的 control-mode / pipe-pane / reattach 行为；
需要上游现有完整运行环境时使用 WSL2。

## 2026-10-05 上游合并与兼容验证

本轮合入上游 `78289b228d616ce47c1f8dee92640d49971d33d3`（2026-10-04），
保留 Windows 默认 PTY、npm 启动器解析、Unicode 输入、原生 Zellij 和 Node IPC 启停。
上游新增的进程身份校验与 Windows 控制队列共同使用；重复 supervisor 不再清空
现有实例的命令队列，停止超时仍保留 supervisor。
Windows 进程身份和命令行查询使用 8 秒有界超时，容纳繁忙机器上 PowerShell/CIM
首次启动超过 2 秒的情况；无法取得身份时仍拒绝启动或停止目标进程。
命令行查询固定 UTF-8，中文及 emoji checkout 路径可以通过真实进程身份校验。
Zellij socket 的长路径、8.3 短路径和扩展路径别名按文件身份验证，拒绝其它会话标记。
Codex 标题同步在预览等待耗尽时继续写入兜底标题，普通读取错误仍直接报错。

严格环境模式在 Windows 上按变量名大小写不敏感匹配 PATH、SystemRoot 和显式授权，
并过滤不同大小写的宿主凭证与会话身份覆盖。原生 Zellij 同样应用严格注入过滤及
Codex 实例凭证边界，不调用 POSIX `env`。Pi 的嵌入源与生成文件固定 LF，MiMoCode
使用平台路径拼接并保留逻辑 `~/` 路径。

本机使用 Bun 1.4.2、Node 24.16.0，通过完整构建、28 个相关测试文件的 890 项测试，
另有 15 项平台限定用例跳过；原生 Windows 下的 POSIX 文件符号链接场景由 Linux CI 验证。
这不是上游全部测试套件的验收。真实 Codex / Claude 管道与 PTY 版本启动、Codex
Unicode 输入框、Zellij 正常/严格环境下的同 PID 重连与关闭均已验证；这些 smoke
不提交模型请求，不代表新增上游功能的完整飞书链路已经验收。

```powershell
bun run build
node --test test/sync-upstream.test.mjs
node scripts/smoke-windows-cli.mjs
node scripts/smoke-windows-codex-input.mjs
node scripts/smoke-windows-zellij.mjs
node scripts/smoke-windows-zellij.mjs --strict
node scripts/smoke-windows-zellij-cli.mjs C:\path\codex.cmd C:\path\claude.exe
```

## 原生 Zellij 托管会话

本次在 Windows 上验证 **Zellij 0.45.1**。安装官方 Windows ZIP 中的 `zellij.exe`，
放入 PATH，然后为机器人选择后端（全局默认仍为 PTY）：

```powershell
zellij --version
node scripts/run-windows-cli.mjs setup edit <机器人进程名或AppID> --backend zellij
node scripts/run-windows-cli.mjs restart
```

新会话使用 Zellij。已经运行的直接 PTY 会话不会被原地迁入 Zellij；应新建话题测试。
Zellij 服务持有原生 CLI，Botmux 的终端客户端断开或工作进程退出后，会话继续运行；
重新连接保留同一 CLI 进程。明确关闭会话才销毁它。Windows 重启会终止进程，不能
把 Zellij 的布局恢复理解为正在执行的任务跨系统重启存活。

Windows 通过 Node 的独立 pane 启动器运行 CLI，复用 `.exe` / npm `.cmd` 解析。
每个 pane 的环境、参数与工作目录经一次性文件传入，读取后立即删除；长提示词和
凭证不写入 Zellij 缓存的布局或命令行。管理员身份在环境合并后重新固定。
输入通过 Zellij 定向字节接口写入内层 ConPTY，避免两层终端翻译丢失 Unicode。

验证命令（先构建）：

```powershell
bun run test -- test/windows-zellij.test.ts test/zellij-backend-helpers.test.ts test/zellij-frozen-reattach.test.ts test/zellij-observe-backend.test.ts test/zellij-session-discovery.test.ts
node scripts/smoke-windows-zellij.mjs
node scripts/smoke-windows-zellij-adopt.mjs
node scripts/smoke-windows-zellij-cli.mjs <Codex启动器绝对路径> <Claude启动器绝对路径>
```

真实生命周期 smoke 验证中文/引号/emoji/多行输入、窗口缩放、参数与环境、管理员
身份、正常断开和工作进程意外退出后同 PID 重连、明确关闭后的 CLI 清理。
真实 CLI smoke 验证 Codex 输入框内容跨重连保持，以及 Claude 原生启动，不提交模型请求。
Windows CI 下载带固定 SHA-256 的 Zellij 0.45.1，执行生命周期和多 pane 接管 smoke；Linux CI
运行现有 Zellij 后端测试。原生 Windows `/adopt` 按 pane 标识绑定进程，拒绝缺失或重复标识，
并在接管前核对对应 pane 与 PID；相同工作目录中的多个 Codex pane 不依赖 PID 排序。
工作目录和 pane 标识通过只读的 Windows x86/x64 进程参数探测取得；无法读取或进程身份改变时拒绝接管。
这个探测依赖 Windows 进程参数布局，当前验收平台为 x64 Windows；其它架构仍需验证。

Zellij **0.45.1 原生 Windows 手动重命名会话暂不支持**：本机复现官方 `action rename-session`
后，新名称的 `action list-panes` 无法连接。Botmux 对这类名称变化拒绝猜测进程，避免接管错误会话。
Codex 冷恢复已模拟终止旧 Zellij server 后重新创建进程，恢复同一 CLI 会话和历史；未执行真实系统重启。
Zellij 内完整 Claude 模型调用按用户要求暂缓。

## 2026-10-06 接管、hooks 与恢复验证

继续合入最新上游 `ece216754`（2026-10-06），同步远程运行器进度换行修复。

修复 Windows hook 命令中反斜杠被当作 shell 转义、超时遗留孙进程的问题；hooks 保留最小环境白名单。
严格模式 pane 启动器仅从 Zellij 继承三个 pane/session 标识，保留凭证隔离。
接管输入复用 ConPTY Unicode 编码，并在一次输入中传送粘贴帧，保留标点、emoji 和多行正文。
Windows 日志持久化以可写句柄执行文件 flush，继续传播真实 I/O 错误；目录 flush 仍是已说明的 best-effort。
源码及嵌入文本固定 LF，避免 Windows checkout 的 CRLF 改变源码检测和嵌入资产。

本机 Node 24.16.0 / Bun 1.4.2：17 个接管、hooks、CLI 适配器、恢复及持久化测试文件，
**875 项通过、6 项平台限定跳过**。正常/严格环境真实 Zellij 生命周期与多 pane 接管 smoke 通过。
真实 Codex 0.154.0 使用模型列表中可用的 `gpt-5.6-luna` 完成模型调用和两轮会话续接；
原生 Zellij 中通过真实 Codex 接管、Unicode 输入框、同 PID 重连及新 PID 冷恢复。
其它 CLI 的启动/恢复参数与 hook 安装由适配器单测覆盖，未据此宣称全部 CLI 的真实模型链路已验收。

同时在合入 `ece216754` 前执行了 Windows 上的全部 1,551 个单测文件。修改期间的探索性扫描记录为
25,653 项通过、1,962 项失败、274 项跳过；一个未退出的测试 worker 被单独终止后生成报告。
这份结果不是最终验收，也不是当前剩余失败数：后续已修复 LF、进程探测、hooks、文件 flush 等问题。
29 个涉及 flush 的文件重测为 390 项通过、69 项失败、3 项跳过，剩余涉及 POSIX 权限、路径和其它工作流行为。
全套仍包含 Unix shell/IPC、符号链接权限、HOME/POSIX 路径以及未移植的上游功能，**全套 Windows 单测尚未全绿**。
Windows CI 是上述已支持路径的阻塞验证；Linux CI 继续执行全部上游单测。

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
真实 PTY 生命周期测试在 Node 的 Windows/Linux 阻塞 CI 中运行；Bun 直接调用
node-pty 会在输出前提前退出，该运行时下仅跳过此 PTY 用例，仍验证查找和启动器解析。

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
工作流创建 PR；当前使用仓库自带 `GITHUB_TOKEN`。它没有 workflow 写权限：
当上游提交修改 `.github/workflows/` 时，GitHub 会拒绝推送，原子推送不会更新任何分支。
2026-10-05 的同步失败即由此造成，本轮已通过维护者 Git 凭证手动快进镜像。
后续遇到同类修改仍需手动同步；无人值守处理需要另行配置具有 workflow 写权限的凭证。
只有 `sync` 作业拥有内容/PR 写权限，运行项目代码的验证作业只有读取权限。
Fork 中已停用继承来的上游发布、npm dist-tag、文档发布和发布审批清理工作流；
这些文件仍保留，避免同步时产生不必要差异。

## 日常开发

从 `codex/windows` 新建 `codex/windows-*` 功能分支，再通过 PR 合回。
不要在 `master` 修改文件，也不要 squash 同步 PR，否则 Git 无法保留上游祖先关系。
普通提交不发布软件；Windows 的正式发布流程待完整运行链路验证后再建立。
