import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

describe('loadHookConfigs mtime cache', () => {
  it('reuses file parse results until mtime or size changes', async () => {
    vi.resetModules();

    const reads: string[] = [];
    const hooksPath = join('/tmp', 'hooks.json');
    const files = new Map<string, string>([
      [hooksPath, JSON.stringify([{ event: 'topic.new', command: '/bin/echo one' }])],
    ]);
    let stat = { mtimeMs: 1000, size: files.get(hooksPath)!.length };

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn((path: string) => files.has(path)),
      readFileSync: vi.fn((path: string) => {
        reads.push(path);
        return files.get(path) ?? '';
      }),
      statSync: vi.fn(() => stat),
    }));
    vi.doMock('../src/config.js', () => ({
      config: { session: { dataDir: '/tmp' } },
    }));
    vi.doMock('../src/utils/logger.js', () => ({
      logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));

    const { loadHookConfigs } = await import('../src/services/hook-runner.js');

    expect(loadHookConfigs({ env: {} })).toEqual([{ event: 'topic.new', command: '/bin/echo one' }]);

    files.set(hooksPath, JSON.stringify([{ event: 'thread.reply', command: '/bin/echo two' }]));
    expect(loadHookConfigs({ env: {} })).toEqual([{ event: 'topic.new', command: '/bin/echo one' }]);
    expect(reads).toEqual([hooksPath]);

    stat = { mtimeMs: 2000, size: files.get(hooksPath)!.length };
    expect(loadHookConfigs({ env: {} })).toEqual([{ event: 'thread.reply', command: '/bin/echo two' }]);
    expect(reads).toEqual([hooksPath, hooksPath]);
  });

  it('caches BOTMUX_HOOKS_JSON by raw env value', async () => {
    vi.resetModules();

    const { loadHookConfigs } = await import('../src/services/hook-runner.js');
    const env = {
      BOTMUX_HOOKS_JSON: JSON.stringify([{ event: 'outbound.send', command: '/bin/echo one' }]),
    };

    const first = loadHookConfigs({ env });
    const second = loadHookConfigs({ env });

    expect(second).toBe(first);
    env.BOTMUX_HOOKS_JSON = JSON.stringify([{ event: 'outbound.reply', command: '/bin/echo two' }]);
    expect(loadHookConfigs({ env })).toEqual([{ event: 'outbound.reply', command: '/bin/echo two' }]);
  });
});
