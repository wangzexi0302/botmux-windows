import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'win32') throw new Error('Run this smoke test on native Windows.');
const root = mkdtempSync(join(tmpdir(), 'botmux-cli-smoke-'));
process.env.SESSION_DATA_DIR = join(root, 'data');
const { createCliAdapterSync } = await import('../dist/adapters/cli/registry.js');
const { PtyBackend } = await import('../dist/adapters/backend/pty-backend.js');
const { resolveExecutableLaunch } = await import('../dist/utils/pty-launch.js');

let exitCode = 0;
try {
  for (const id of ['codex', 'claude-code']) {
    const adapter = createCliAdapterSync(id);
    const launch = resolveExecutableLaunch(adapter.resolvedBin, ['--version'], process.env);
    const version = execFileSync(launch.bin, launch.args, { encoding: 'utf8', timeout: 20_000, windowsHide: true }).trim();
    if (!/\d+\.\d+/.test(version)) throw new Error(`No pipe version received from ${id}`);
    console.log(`${id}: ${version} (native Windows pipe, exit 0)`);
    const backend = new PtyBackend();
    let output = '';
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { backend.kill(); reject(new Error(`${id} timed out: ${output}`)); }, 20_000);
        try {
          backend.spawn(adapter.resolvedBin, ['--version'], {
            cwd: root, cols: 180, rows: 30, env: process.env,
          });
          backend.onData(data => { output += data; });
          backend.onExit(code => {
            clearTimeout(timeout);
            code === 0 ? resolve() : reject(new Error(`${id} exited ${code}: ${output}`));
          });
        } catch (error) { clearTimeout(timeout); reject(error); }
      });
      const plain = output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
      if (!/\d+\.\d+/.test(plain)) throw new Error(`No version received from ${id}: ${plain}`);
      console.log(`${id}: ${plain} (native Windows PTY, exit 0)`);
    } finally { backend.kill(); }
  }
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally { rmSync(root, { recursive: true, force: true }); }
// The shared adapter registry initializes background timers. This one-shot
// command is complete once both children have exited and its temp data is gone.
process.exit(exitCode);
