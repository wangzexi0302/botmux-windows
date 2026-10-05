import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDurableProcessIdentity } from '../src/utils/process-identity.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import {
  builtinFleetEntryMatches,
  inspectFleetProcess,
  signalAttestedFleetProcess,
  inspectSupervisorState,
  readFleetProcessCommandLine,
  type FleetProcessIdentityRuntime,
} from '../src/core/fleet-process-identity.js';

function runtime(identities: Array<string | undefined>, commands: Array<string | undefined>): FleetProcessIdentityRuntime {
  return {
    readIdentity: vi.fn(() => identities.shift()),
    readCommandLine: vi.fn(() => commands.shift()),
    readPidNamespace: vi.fn(() => undefined),
    pidExists: vi.fn(() => true),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('fleet process identity', () => {
  it.skipIf(process.platform !== 'win32')('attests a real supervisor entry under a Chinese and emoji path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux 中文🧪-'));
    const entry = join(root, 'index-supervisor.js');
    writeFileSync(entry, "console.log('ready'); setInterval(() => {}, 1000);\n");
    const child = spawnTsScript(entry, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('supervisor fixture did not become ready')), 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
      });
      const pid = child.pid!;
      const processStart = readDurableProcessIdentity(pid);
      if (!processStart) throw new Error('Missing fixture process identity');
      expect(readFleetProcessCommandLine(pid)).toContain(entry);
      expect(inspectSupervisorState({
        supervisorPid: pid,
        supervisorStartedAt: new Date().toISOString(),
        supervisorEntry: entry,
        supervisorProcessStart: processStart,
        procs: [],
      }).status).toBe('exact');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          child.once('close', () => resolve());
          child.kill();
        });
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 45_000);

  it('matches built-in roles across checkout paths without accepting another role', () => {
    expect(builtinFleetEntryMatches('daemon', '/usr/bin/node /old/review/dist/index-daemon.js')).toBe(true);
    expect(builtinFleetEntryMatches('daemon', '/usr/bin/node "/old review/dist/index-daemon.js"')).toBe(true);
    expect(builtinFleetEntryMatches('daemon', '/new/botmux __daemon')).toBe(true);
    expect(builtinFleetEntryMatches('daemon', '/new/botmux __dashboard')).toBe(false);
    expect(builtinFleetEntryMatches('daemon', '/tmp/index-daemon.js.backup')).toBe(false);
    expect(builtinFleetEntryMatches('dashboard', '/usr/bin/node /new/dist/index-dashboard.js')).toBe(true);
    expect(builtinFleetEntryMatches('supervisor', '/usr/bin/node /old/dist/index-supervisor.js')).toBe(true);
    expect(builtinFleetEntryMatches('supervisor', '/new/botmux __supervisor')).toBe(true);
    expect(builtinFleetEntryMatches('supervisor', '/new/botmux __supervisor-helper')).toBe(false);
    expect(builtinFleetEntryMatches('supervisor', '/tmp/index-supervisor.js.backup')).toBe(false);
  });
  it('accepts a persisted birth identity without consulting a recomputed command', () => {
    const result = inspectFleetProcess(61, 'boot-a:123', undefined, cmd => cmd.includes('__supervisor'),
      runtime(['boot-a:123', 'boot-a:123'], ['/different/checkout/index-supervisor.js']), false);
    expect(result).toEqual({
      status: 'exact',
      attestation: { pid: 61, processStart: 'boot-a:123' },
    });
  });

  it('treats a live unrelated process at the recorded pid as stale', () => {
    expect(inspectFleetProcess(61, 'boot-a:123', undefined, cmd => cmd.includes('__supervisor'),
      runtime(['boot-a:999'], ['[ksoftirqd/9]']))).toEqual({ status: 'stale' });
  });

  it('needs no command-line access once the persisted generation already mismatches', () => {
    expect(inspectFleetProcess(61, 'boot-a:123', undefined, () => true,
      runtime(['boot-a:999'], [undefined]))).toEqual({ status: 'stale' });
  });

  it('migrates legacy state only after a stable command-line and birth check', () => {
    const result = inspectFleetProcess(61, undefined, undefined, cmd => cmd.includes('index-supervisor.js'),
      runtime(['boot-a:123', 'boot-a:123'], ['node /opt/botmux/dist/index-supervisor.js']));
    expect(result.status).toBe('exact');
  });

  it('rejects a pid recycled during inspection', () => {
    expect(inspectFleetProcess(61, undefined, undefined, () => true,
      runtime(['boot-a:123', 'boot-a:999'], ['node /opt/botmux/dist/index-supervisor.js']))).toEqual({ status: 'stale' });
  });

  it('treats a process that exits before the second identity read as stale', () => {
    const deps = runtime(['boot-a:123', undefined], ['node /opt/botmux/dist/index-supervisor.js']);
    deps.pidExists = () => false;
    expect(inspectFleetProcess(61, undefined, undefined, () => true, deps)).toEqual({ status: 'stale' });
  });

  it('fails closed when identity evidence is unreadable', () => {
    expect(inspectFleetProcess(61, 'boot-a:123', undefined, () => true,
      runtime([undefined], ['/opt/botmux __supervisor']))).toEqual({ status: 'unverifiable' });
  });

  it('does not require command-line access for a persisted birth identity', () => {
    expect(inspectFleetProcess(61, 'boot-a:123', undefined, () => false,
      runtime(['boot-a:123', 'boot-a:123'], [undefined]), false).status).toBe('exact');
  });

  it('treats an unreadable pid as stale only when the OS confirms it is gone', () => {
    const deps = runtime([undefined], [undefined]);
    deps.pidExists = () => false;
    expect(inspectFleetProcess(61, 'boot-a:123', undefined, () => true, deps)).toEqual({ status: 'stale' });
  });

  it('rejects a matching pid and birth identity from another Linux PID namespace', () => {
    const deps = runtime(['boot-a:123'], ['/opt/botmux __supervisor']);
    deps.readPidNamespace = () => 'pid:[999]';
    expect(inspectFleetProcess(61, 'boot-a:123', 'pid:[100]', () => true, deps)).toEqual({ status: 'stale' });
  });

  it('does not signal after the attested generation changes', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    const ok = signalAttestedFleetProcess(
      { pid: 61, processStart: 'boot-a:123', commandLine: '/opt/botmux __supervisor' },
      'SIGTERM',
      runtime(['boot-a:999'], ['/opt/botmux __supervisor']),
    );
    expect(ok).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not signal after the attested command line changes', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    const ok = signalAttestedFleetProcess(
      { pid: 61, processStart: 'boot-a:123', commandLine: '/opt/botmux __supervisor' },
      'SIGHUP',
      runtime(['boot-a:123'], ['sleep 600']),
    );
    expect(ok).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not signal when the generation changes after the command check', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    const ok = signalAttestedFleetProcess(
      { pid: 61, processStart: 'boot-a:123', commandLine: '/opt/botmux __supervisor' },
      'SIGKILL',
      runtime(['boot-a:123', 'boot-a:999'], ['/opt/botmux __supervisor']),
    );
    expect(ok).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('signals only after both identity checks and the command check stay exact', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    const ok = signalAttestedFleetProcess(
      { pid: 61, processStart: 'boot-a:123', commandLine: '/opt/botmux __supervisor' },
      'SIGTERM',
      runtime(['boot-a:123', 'boot-a:123'], ['/opt/botmux __supervisor']),
    );
    expect(ok).toBe(true);
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(61, 'SIGTERM');
  });

  it('propagates permission errors instead of treating a verified process as gone', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    expect(() => signalAttestedFleetProcess(
      { pid: 61, processStart: 'boot-a:123', commandLine: '/opt/botmux __supervisor' },
      'SIGTERM',
      runtime(['boot-a:123', 'boot-a:123'], ['/opt/botmux __supervisor']),
    )).toThrow(/operation not permitted/);
  });
});
