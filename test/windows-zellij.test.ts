import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(), spawnSync: vi.fn() };
});
import { execFileSync, spawnSync } from 'node:child_process';
import { buildWindowsZellijPane, writeWindowsZellijInput, findWindowsZellijProcess } from '../src/utils/windows-zellij.js';
import { buildLayoutString, kdlString } from '../src/adapters/backend/zellij-backend.js';
import { zellijEnv, probeZellijFunctional } from '../src/setup/ensure-zellij.js';
import { encodeWindowsPtyInput } from '../src/utils/windows-pty-input.js';

const dirs: string[] = [];
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('KDL quotes multiline/control input without introducing layout nodes', () => {
  expect(kdlString('a\nb\r\tc"d\\e')).toBe('"a\\nb\\r\\tc\\"d\\\\e"');
});

describe.skipIf(process.platform !== 'win32')('Windows Zellij', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'bmx-zellij-unit-')); dirs.push(dir);
    writeFileSync(join(dir, 'cli.cjs'), '');
    const shim = join(dir, 'cli.cmd');
    writeFileSync(shim, '@echo off\r\n"%_prog%" "%dp0%\\cli.cjs" %*\r\n');
    return { dir, shim };
  }

  it('keeps credentials/long arguments in a one-shot bootstrap and pins the owner after env merging', () => {
    const { dir, shim } = fixture();
    const bootstrap = join(dir, 'launch.json');
    const opts = { cwd: dir, cols: 100, rows: 30,
      env: { ...process.env, BOTMUX_OWNER_OPEN_ID: 'owner', PATH: process.env.PATH! },
      injectEnv: { botmux_owner_open_id: 'forged', __OWNER_OPEN_ID: 'forged', Path: process.env.PATH!, PROVIDER_SECRET: 'test-secret' } };
    const args = ['中文“引号” & %PATH%', 'line\n'.repeat(10000)];
    const launch = buildWindowsZellijPane(shim, args, opts, bootstrap);
    const spec = JSON.parse(launch.bootstrap);
    expect(spec.args).toEqual([join(dir, 'cli.cjs'), ...args]);
    expect(spec.env.BOTMUX_OWNER_OPEN_ID).toBe('owner');
    expect(spec.env.__OWNER_OPEN_ID).toBe('owner');
    expect(spec.env.Path).toBeUndefined();
    expect(spec.env.PROVIDER_SECRET).toBe('test-secret');
    const layout = buildLayoutString(shim, args, opts, bootstrap);
    expect(layout).toContain('launch.json');
    expect(layout).not.toContain('test-secret');
    expect(layout).not.toContain(args[0]);
    expect(layout).not.toContain('/usr/bin/env');
    expect(layout.length).toBeLessThan(2000);
  });

  it('removes both owner aliases for an ownerless session', () => {
    const { dir, shim } = fixture();
    const spec = JSON.parse(buildWindowsZellijPane(shim, [], { cwd: dir, cols: 100, rows: 30,
      env: { ...process.env, BOTMUX_OWNER_OPEN_ID: undefined, __OWNER_OPEN_ID: 'stale' } as any,
      injectEnv: { BOTMUX_OWNER_OPEN_ID: 'forged' } }, join(dir, 'launch.json')).bootstrap);
    expect(spec.env.BOTMUX_OWNER_OPEN_ID).toBeUndefined();
    expect(spec.env.__OWNER_OPEN_ID).toBeUndefined();
  });

  it('scrubs session/provider authority from the server environment', () => {
    const env = zellijEnv({ Path: 'C:\\bin', BOTMUX_OWNER_OPEN_ID: 'owner', __OWNER_OPEN_ID: 'owner',
      LARK_APP_SECRET: 'secret', ZELLIJ: '0', zellij_session_name: 'outer', ZELLIJ_PANE_ID: '2', HTTPS_PROXY: 'secret-proxy' });
    expect(env).toEqual({ Path: 'C:\\bin' });
  });

  it('writes all encoded bytes to an explicit pane in bounded ordered chunks', () => {
    const value = '\x1b[200~中文——😀\x00\r\n'.repeat(250) + '\x1b[201~';
    writeWindowsZellijInput('bmx-test', value, 'terminal_2');
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    const bytes = calls.flatMap(([, argv]) => {
      const args = argv as string[];
      expect(args.slice(0, 6)).toEqual(['--session', 'bmx-test', 'action', 'write', '--pane-id', 'terminal_2']);
      expect(args.slice(6).length).toBeLessThanOrEqual(2048);
      return args.slice(6).map(Number);
    });
    expect(Buffer.from(bytes).toString('utf8')).toBe(encodeWindowsPtyInput(value));
  });

  it('never retries an input chunk after an ambiguous delivery error', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('timeout'); });
    expect(() => writeWindowsZellijInput('bmx-test', '中文'.repeat(500))).toThrow('timeout');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('refuses traversal session names without looking up a process', () => {
    expect(findWindowsZellijProcess('../elsewhere', true)).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('rejects stale PID markers and only resolves a unique pane launcher child', () => {
    const { dir } = fixture();
    const sockets = join(dir, 'contract_version_1'); mkdirSync(sockets);
    const marker = join(sockets, 'bmx-test'); writeFileSync(marker, '1234');
    vi.stubEnv('ZELLIJ_SOCKET_DIR', dir);
    const server = { pid: 1234, parent: 1, name: 'zellij.exe', command: `zellij.exe --server "${marker}"`, created: Date.now() - 5000 };
    const runner = { pid: 1235, parent: 1234, name: 'node.exe', command: 'node -e "/* botmux-zellij-pane */"' };
    const child = { pid: 1236, parent: 1235, name: 'claude.exe' };
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([server, runner, child]) as any);
    expect(findWindowsZellijProcess('bmx-test', true)).toBe(1236);
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([{ ...server, created: Date.now() + 1000 }, runner, child]) as any);
    expect(findWindowsZellijProcess('bmx-test', true)).toBeNull();
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([server, runner, child, { ...child, pid: 1237 }]) as any);
    expect(findWindowsZellijProcess('bmx-test', true)).toBeNull();
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([{ ...server, command: 'zellij.exe --server C:\\other-session' }, runner, child]) as any);
    expect(findWindowsZellijProcess('bmx-test', true)).toBeNull();
  });
});

describe('Zellij functional probe cleanup', () => {
  it('does not report success when create exits zero but no live session exists', () => {
    vi.mocked(execFileSync).mockReturnValue('zellij 0.45.1' as any);
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as any);
    expect(probeZellijFunctional()).toEqual({ ok: false, reason: expect.stringContaining('未确认后台会话存活') });
    expect(vi.mocked(spawnSync).mock.calls.at(-1)?.[1]).toEqual(['delete-session', expect.stringMatching(/^bmx-probe-/), '-f']);
  });

  it('attempts cleanup even when creation times out', () => {
    vi.mocked(execFileSync).mockReturnValue('zellij 0.45.1' as any);
    vi.mocked(spawnSync).mockReturnValue({ status: null, stderr: '', error: new Error('timeout') } as any);
    expect(probeZellijFunctional().ok).toBe(false);
    expect(vi.mocked(spawnSync).mock.calls.at(-1)?.[1]?.[0]).toBe('delete-session');
  });
});
