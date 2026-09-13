import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { locateExecutable } from '../src/utils/executable.js';
import { resolvePtyLaunch } from '../src/utils/pty-launch.js';
import { createCliAdapterSync, resolveCommand } from '../src/adapters/cli/registry.js';
import { detectDefaultBackend } from '../src/config.js';
import { PtyBackend } from '../src/adapters/backend/pty-backend.js';

const roots: string[] = [];
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'botmux 空格 & launch-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('selects ConPTY only on Windows, retaining the POSIX tmux default', () => {
  expect(detectDefaultBackend('win32')).toBe('pty');
  expect(detectDefaultBackend('linux')).toBe('tmux');
  expect(detectDefaultBackend('darwin')).toBe('tmux');
});

describe.skipIf(process.platform !== 'win32')('Windows executable resolution', () => {
  it('finds npm .cmd instead of a POSIX shim, with case-insensitive env and quoted PATH', () => {
    const root = temp();
    writeFileSync(join(root, 'codex'), '#!/bin/sh\n');
    writeFileSync(join(root, 'codex.cmd'), '@echo off\n');
    expect(locateExecutable('codex', { Path: `"${root}"`, Pathext: '.EXE;.CMD' })).toBe(join(root, 'codex.cmd'));
    expect(locateExecutable(join(root, 'codex'), { PATHEXT: '.CMD' })).toBe(join(root, 'codex.cmd'));
    expect(locateExecutable('missing', { PATH: root })).toBeNull();
    writeFileSync(join(root, 'tools.cli.exe'), 'fixture');
    expect(locateExecutable('tools.cli', { PATH: root })).toBe(join(root, 'tools.cli.exe'));
  });

  it('does not accept unsupported script types or directories', () => {
    const root = temp();
    mkdirSync(join(root, 'codex.EXE'));
    writeFileSync(join(root, 'codex.ps1'), 'exit 0');
    expect(locateExecutable('codex', { PATH: root, PATHEXT: '.PS1;.EXE' })).toBeNull();
    expect(locateExecutable(join(root, 'codex.ps1'))).toBeNull();
  });

  it('resolves both Codex and Claude through the shared registry without Unix shell probes', () => {
    const root = temp();
    const original = process.env.PATH;
    writeFileSync(join(root, 'codex.cmd'), '@echo off');
    writeFileSync(join(root, 'claude.exe'), 'fixture');
    process.env.PATH = root;
    try {
      expect(resolveCommand('codex').toLowerCase()).toBe(join(root, 'codex.cmd').toLowerCase());
      expect(createCliAdapterSync('codex').resolvedBin.toLowerCase()).toBe(join(root, 'codex.cmd').toLowerCase());
      expect(createCliAdapterSync('claude-code').resolvedBin.toLowerCase()).toBe(join(root, 'claude.exe').toLowerCase());
    } finally {
      if (original === undefined) delete process.env.PATH; else process.env.PATH = original;
    }
  });

  it('rejects arbitrary batch files instead of interpreting arguments in a shell', () => {
    const root = temp();
    const batch = join(root, 'custom.cmd');
    writeFileSync(batch, '@echo off\n%*');
    expect(() => resolvePtyLaunch(batch, ['& echo injected'], process.env)).toThrow(/native .exe/);
  });
});

// A real ConPTY/POSIX PTY, with arguments observed by the child, not a spawn mock.
describe('PTY launch and lifecycle', () => {
  for (const npmShim of (process.platform === 'win32' ? [false, true] : [false])) {
    it(`round-trips Unicode/quoted argv, env and input (${npmShim ? 'npm shim' : 'native'})`, async () => {
      const root = temp();
      const entry = join(root, 'entry.cjs');
      const result = join(root, 'result.json');
      writeFileSync(entry, `const fs = require('node:fs');
fs.writeFileSync(process.env.RESULT, JSON.stringify({ args: process.argv.slice(2), owner: process.env.BOTMUX_OWNER_OPEN_ID, cwd: process.cwd() }));
console.log('BOTMUX_READY');
process.stdin.on('data', data => { if (data.toString().includes('ping')) { console.log('BOTMUX_PONG'); process.exit(0); } });
`);
      const batch = join(root, 'fixture.cmd');
      writeFileSync(batch, '@echo off\r\n"%_prog%" "%dp0%\\entry.cjs" %*\r\n');
      const argv = ['中文 空格', 'a&b', '%PATH%', '!literal!', 'say "hi"', 'tail\\', '$(literal)', ''];
      const backend = new PtyBackend();
      const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, RESULT: result };
      let output = '';
      let wrote = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => { backend.kill(); reject(new Error(`PTY timed out: ${output}`)); }, 12_000);
          try {
            backend.spawn(npmShim ? batch : process.execPath, npmShim ? argv : [entry, ...argv], {
              cwd: root, cols: 160, rows: 30, env,
              injectEnv: { BOTMUX_OWNER_OPEN_ID: 'test-owner' },
            });
            backend.onData(data => {
              output += data;
              if (!wrote && output.includes('BOTMUX_READY')) {
                wrote = true;
                backend.resize(180, 35);
                backend.write('ping\r');
              }
            });
            backend.onExit(code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`PTY exited ${code}: ${output}`)); });
          } catch (error) { clearTimeout(timeout); reject(error); }
        });
        expect(output).toContain('BOTMUX_PONG');
        expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({ args: argv, owner: 'test-owner', cwd: root });
      } finally { backend.kill(); }
      expect(backend.getChildPid()).toBeNull();
    }, 15_000);
  }
});
