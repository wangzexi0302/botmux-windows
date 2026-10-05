/**
 * 跨平台冒烟测试：`readComm` / `readCwd` / `getChildPids` 必须在 Linux 和
 * macOS 上都能正确识别一个真实的子进程。
 *
 * 这里**不 mock**任何东西 —— 直接 spawn 一个 Node 子进程当 target，跑实际
 * 命令验证返回值。和 session-discovery.test.ts 的 mock-based 单测互补：
 * - mock-based 单测覆盖 discovery 的组合逻辑、tmux 输出解析、边界 case
 * - smoke 测试切实抓平台命令兼容性（macOS BSD ps 不支持 GNU 长选项 `--ppid`
 *   等历史回归，纯 mock 测不到）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import {
  __testOnly_readComm,
  __testOnly_readCwd,
  __testOnly_getChildPids,
  readCmdline, readProcessStartTime,
} from '../src/core/session-discovery.js';
import { windowsProcessContext, windowsChildPids, splitWindowsCommandLine, type WindowsProcessInfo } from '../src/utils/windows-process.js';

let child: ChildProcessWithoutNullStreams;
let childCwd: string;
let tempRoot: string;
let childLaunchedAt: number;

// A cold PowerShell/CIM/CodeDom start can exhaust a bounded query on a busy
// Windows runner. Re-probe after a failure, just as a new discovery request
// would; never turn an unreadable identity into a successful match.
async function probe<T>(read: () => T | undefined): Promise<T | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
  return undefined;
}

beforeAll(async () => {
  // macOS 的 tmpdir 通常是 /var/folders/.. 的软链，真实路径在 /private/var/...
  // lsof 返回 resolve 后的路径，提前 realpath 一下让断言里两边形态一致。
  tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'bmx-sd-')));
  childCwd = join(tempRoot, '进程 探测 😀');
  mkdirSync(childCwd);
  // 子进程保持运行直到 afterAll 明确关闭。stdout 输出 "ready" 后
  // 才认为 cwd / pid 都已稳定。
  childLaunchedAt = Date.now();
  child = spawn(
    process.execPath,
    ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);', '引号“” 😀 a&b'],
    { cwd: childCwd, env: { ...process.env, ZELLIJ_PANE_ID: '42', BMX_PRIVATE_PROBE_SENTINEL: 'must-not-be-returned' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  ) as ChildProcessWithoutNullStreams;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child not ready in 5s')), 5000);
    child.stdout.once('data', (buf: Buffer) => {
      if (buf.toString().includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', reject);
  });
});

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

describe('native process identity', () => {
  it('does not attach an orphan to a recycled parent PID', () => {
    const rows: WindowsProcessInfo[] = [
      { pid: 100, parent: 1, created: 2000, name: 'zellij.exe', command: '' },
      { pid: 101, parent: 100, created: 1000, name: 'codex.exe', command: '' },
      { pid: 102, parent: 100, created: 2000, name: 'node.exe', command: '' },
      { pid: 103, parent: 100, created: 3000, name: 'codex.exe', command: '' },
    ];
    expect(windowsChildPids(100, rows)).toEqual([102, 103]);
    expect(windowsChildPids(99, rows)).toEqual([]);
  });
  it('reads the command line and process birth time', async () => {
    const argv = await probe(() => { const a = readCmdline(child.pid!); return a.length ? a : undefined; });
    expect(argv?.join(' ')).toContain('引号“” 😀 a&b');
    const created = await probe(() => readProcessStartTime(child.pid!));
    expect(created).toBeGreaterThanOrEqual(childLaunchedAt - 1000);
    expect(created).toBeLessThanOrEqual(Date.now());
  }, 60_000);
  it.runIf(process.platform === 'win32')('returns only cwd, pane identifier and birth time from native process memory', async () => {
    const context = await probe(() => windowsProcessContext(child.pid!));
    const created = await probe(() => readProcessStartTime(child.pid!));
    expect(context).toEqual({ cwd: childCwd, paneId: 'terminal_42', created });
    expect(windowsProcessContext(-1)).toBeUndefined();
  }, 60_000);
  it('parses Windows drive/UNC paths, quotes, empty arguments and Unicode without shell expansion', () => {
    // Bun 1.4.2 rewrites non-ASCII raw-template text to literal Unicode escapes.
    // Interpolation keeps the actual characters while preserving path slashes.
    const unicode = '中文 😀 %PATH% a&b';
    expect(splitWindowsCommandLine(String.raw`"C:\\Program Files\\node.exe" "\\\\server\\share\\codex.js" "" "${unicode}"`))
      .toEqual([String.raw`C:\\Program Files\\node.exe`, String.raw`\\\\server\\share\\codex.js`, '', unicode]);
    expect(splitWindowsCommandLine('node "unterminated')).toEqual([]);
  });
});

describe('readComm', () => {
  it('返回子进程的 comm 名 (basename, 不含路径)', () => {
    const comm = __testOnly_readComm(child.pid!);
    expect(comm).toBeDefined();
    // Linux /proc/<pid>/comm 给短名 "node"；BSD ps 给完整路径，readComm
    // 已统一 basename，所以这里都不应包含 "/"。
    expect(comm).not.toContain('/');
    // The child is `process.execPath`: Node on vitest, bun on `bun test`.
    // Linux `/proc/<pid>/comm` is the short name of whichever runtime we spawned.
    expect(comm).toMatch(/^(node|bun)/i);
  });

  it('对不存在的 PID 返回 undefined', () => {
    // 取一个明显不存在的大 PID。ps / /proc 都读不到。
    expect(__testOnly_readComm(2_000_000)).toBeUndefined();
  });
});

describe('readCwd', () => {
  it('返回子进程的工作目录', () => {
    const cwd = __testOnly_readCwd(child.pid!);
    expect(cwd).toBeDefined();
    expect(cwd).toBe(childCwd);
  });

  it('对不存在的 PID 返回 undefined', () => {
    expect(__testOnly_readCwd(2_000_000)).toBeUndefined();
  });
});

describe('getChildPids', () => {
  it('能在当前进程的子进程列表里找到 spawn 出来的 child', () => {
    const children = __testOnly_getChildPids(process.pid);
    expect(children).toContain(child.pid);
  });

  it('对不存在的 PID 返回空数组', () => {
    expect(__testOnly_getChildPids(2_000_000)).toEqual([]);
  });
});
