/**
 * Zellij availability probe + env hygiene, mirroring ensure-tmux.ts.
 *
 * Zellij is an OPT-IN backend (BACKEND_TYPE=zellij) — there's no auto-install
 * here (tmux stays the default). We only need a functional probe so the worker
 * can hard-gate the session (post an actionable card, refuse to start) when
 * zellij is requested but unusable — it no longer silently falls back to PTY —
 * and an env sanitiser so nested-session vars don't make our `zellij` calls
 * target the wrong server.
 *
 * The driveable automation surface (action write/dump-screen/list-panes --json,
 * headless `attach --create-background`) landed in zellij 0.40–0.44; we require
 * >= 0.44.0 because send-keys / `--ansi` dumps / JSON pane listing all arrived
 * in 0.44.0 and older zellij is not a viable backend.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateExecutable } from '../utils/executable.js';
import { isBotmuxManagedTmuxEnvKey } from '../utils/child-env.js';

/** Minimum zellij version with the full CLI-automation surface we depend on. */
export const MIN_ZELLIJ_VERSION = { major: 0, minor: 44, patch: 0 };

/**
 * Strip zellij-injected env vars when spawning a `zellij` child process.
 *
 * If the parent was launched from inside a zellij session, `ZELLIJ` and
 * `ZELLIJ_SESSION_NAME` are exported. Any `zellij` subcommand we run then
 * resolves against that parent session (e.g. `action` targets the wrong
 * session, `attach` nests), so we drop them — the analogue of tmuxEnv()
 * stripping TMUX/TMUX_PANE.
 */
export function zellijEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    return Object.fromEntries(Object.entries(env).filter(([key]) => {
      const upper = key.toUpperCase();
      return !['ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID'].includes(upper)
        && !isBotmuxManagedTmuxEnvKey(key) && !isBotmuxManagedTmuxEnvKey(upper);
    }));
  }
  const { ZELLIJ: _z, ZELLIJ_SESSION_NAME: _zn, ...rest } = env;
  return rest;
}

/** Parse `zellij 0.44.1` → {major,minor,patch}. Returns undefined if unparseable. */
export function parseZellijVersion(raw: string): { major: number; minor: number; patch: number } | undefined {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True iff `v` >= MIN_ZELLIJ_VERSION (pure — unit testable). */
export function isZellijVersionSupported(
  v: { major: number; minor: number; patch: number },
  min = MIN_ZELLIJ_VERSION,
): boolean {
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

function probeZellijVersion(): string | undefined {
  try {
    return execFileSync('zellij', ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      windowsHide: true,
      env: zellijEnv(),
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Functional zellij probe — actually creates a headless background session and
 * tears it down. `zellij --version` only checks the binary; this verifies the
 * server can fork + that the version is new enough.
 *
 * Uses `attach --create-background` (no TTY required — verified) and
 * `delete-session -f` so we never leave a resurrectable corpse behind.
 */
export function probeZellijFunctional(): { ok: true; version: string } | { ok: false; reason: string } {
  const raw = probeZellijVersion();
  if (!raw) return { ok: false, reason: 'zellij 二进制不在 PATH 上' };
  const parsed = parseZellijVersion(raw);
  if (!parsed) return { ok: false, reason: `无法解析 zellij 版本：${raw}` };
  if (!isZellijVersionSupported(parsed)) {
    return {
      ok: false,
      reason: `${raw} 过旧，需 >= ${MIN_ZELLIJ_VERSION.major}.${MIN_ZELLIJ_VERSION.minor}.${MIN_ZELLIJ_VERSION.patch}（CLI 自动化能力 send-keys/dump-screen --ansi/list-panes --json 在 0.44.0 才齐全）`,
    };
  }
  const name = `bmx-probe-${process.pid}-${Date.now()}`;
  let dir: string | undefined;
  try {
    let prefix: string[] = [];
    if (process.platform === 'win32') {
      // A headless cmd.exe can exit on EOF while attach still returns zero.
      // Use a bounded native process and verify the resulting session exists.
      const node = locateExecutable('node', process.env);
      if (!node) return { ok: false, reason: 'Windows Zellij 探针需要 Node.js' };
      dir = mkdtempSync(join(tmpdir(), 'bmx-zellij-probe-'));
      const layout = join(dir, 'probe.kdl');
      writeFileSync(layout, `layout {\n pane command=${JSON.stringify(node)} close_on_exit=true {\n args "-e" "setTimeout(()=>{},30000)"\n }\n}\n`);
      prefix = ['--new-session-with-layout', layout];
    }
    const create = spawnSync('zellij', [...prefix, 'attach', '--create-background', name], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5000,
      env: zellijEnv(),
      windowsHide: true,
    });
    if (create.status !== 0) {
      const stderr = (create.stderr?.toString() ?? '').trim();
      return { ok: false, reason: stderr || `zellij attach --create-background 失败 (exit ${create.status})` };
    }
    const listed = spawnSync('zellij', ['list-sessions', '--no-formatting'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000, env: zellijEnv(),
    });
    if (listed.status !== 0 || !listed.stdout.split('\n').some(line => line.split(/\s+/)[0] === name && !/EXITED/i.test(line))) {
      return { ok: false, reason: 'zellij 创建命令返回成功，但未确认后台会话存活' };
    }
    return { ok: true, version: raw };
  } catch (error) {
    return { ok: false, reason: `zellij 探针失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    // The server may have started even if the create request timed out.
    spawnSync('zellij', ['delete-session', name, '-f'], { windowsHide: true, stdio: 'ignore', timeout: 3000, env: zellijEnv() });
    if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* a late server may still hold the config */ } }
  }
}
