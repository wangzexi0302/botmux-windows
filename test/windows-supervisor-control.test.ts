import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestWindowsFleetStop, consumeWindowsFleetStop } from '../src/core/windows-fleet-control.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { WINDOWS_PARENT_SHUTDOWN_MESSAGE } from '../src/utils/windows-parent-shutdown.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('consumes only a stop request for the exact supervisor generation, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-windows-control-'));
  dirs.push(dir);
  const path = join(dir, 'stop.json');
  const identity = { supervisorPid: 12345, supervisorStartedAt: '2026-01-01T00:00:00Z' };
  requestWindowsFleetStop(path, identity);
  expect(consumeWindowsFleetStop(path, { ...identity, supervisorStartedAt: '2026-01-02T00:00:00Z' })).toBe(false);
  requestWindowsFleetStop(path, identity);
  expect(consumeWindowsFleetStop(path, { ...identity, supervisorPid: 12346 })).toBe(false);
  requestWindowsFleetStop(path, identity);
  expect(consumeWindowsFleetStop(path, identity)).toBe(true);
  expect(consumeWindowsFleetStop(path, identity)).toBe(false);
  writeFileSync(path, '{');
  expect(consumeWindowsFleetStop(path, identity)).toBe(false);
  expect(() => requestWindowsFleetStop(path, { ...identity, supervisorPid: 0 })).toThrow();
});

describe.skipIf(process.platform !== 'win32')('native Windows parent shutdown IPC', () => {
  for (const trigger of ['message', 'disconnect'] as const) {
    it(`runs cleanup after readiness when ${trigger} arrives during startup`, async () => {
      const child = spawnTsEvalWithRepoImports(`
import { installWindowsParentShutdown } from './src/utils/windows-parent-shutdown.js';
const ready = installWindowsParentShutdown();
process.send('installed');
setTimeout(() => {
  process.on('SIGTERM', () => { console.log('CLEAN_SHUTDOWN'); process.exit(90); });
  ready();
}, 150);
setInterval(() => {}, 1000);
`, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      let output = '';
      child.stdout!.on('data', data => { output += data; });
      child.stderr!.on('data', data => { output += data; });
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(output || 'IPC timeout')), 5000);
          child.once('error', reject);
          child.once('exit', code => { clearTimeout(timeout); resolve(code); });
          child.once('message', () => {
            if (trigger === 'disconnect') child.disconnect();
            else child.send(WINDOWS_PARENT_SHUTDOWN_MESSAGE);
          });
        });
        expect(code, output).toBe(90);
        expect(output).toContain('CLEAN_SHUTDOWN');
      } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
    });
  }
});
