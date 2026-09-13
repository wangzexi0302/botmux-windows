// Real Codex composer + Claude startup in native Zellij. No prompt submitted.
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
import { ZellijBackend } from '../dist/adapters/backend/zellij-backend.js';
import { createCliAdapterSync } from '../dist/adapters/cli/registry.js';

if (process.platform !== 'win32') throw new Error('Run on native Windows.');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate, message, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await pause(100); }
  throw new Error(message);
}
for (const cli of ['codex', 'claude-code']) {
  const name = `bmx-cli-smoke-${process.pid}-${cli}`;
  const adapter = createCliAdapterSync(cli, cli === 'codex' ? process.argv[2] : process.argv[3]);
  let backend = new ZellijBackend(name);
  let terminal = new xterm.Terminal({ cols: 160, rows: 40, allowProposedApi: true });
  let cliPid;
  let rawOutput = '';
  const screen = () => {
    const b = terminal.buffer.active; const lines = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  };
  const opts = { cwd: process.cwd(), cols: 160, rows: 40, env: { ...process.env, TERM: 'xterm-256color' } };
  const args = cli === 'codex' ? ['--no-alt-screen', '-c', 'check_for_update_on_startup=false'] : ['--version'];
  try {
    backend.spawn(adapter.resolvedBin, args, opts);
    backend.onData(data => { rawOutput += data; terminal.write(data); }); backend.onExit(() => {});
    if (cli === 'claude-code') {
      await until(() => /\d+\.\d+\.\d+.*Claude Code/.test(rawOutput), 'Claude version output missing');
      console.log('PASS Claude native executable starts inside Zellij.');
      continue;
    }
    await until(() => /│\s+model:\s+(?!loading\b)\S/.test(screen()) && /›/.test(screen()), 'Codex composer not ready');
    cliPid = backend.getChildPid();
    assert.ok(cliPid, 'Codex launcher PID found');
    const expected = 'BOTMUX-ZELLIJ 中文“引号”——→→ 😀😀 café a&b %PATH% DONE';
    backend.pasteText(expected);
    await until(() => screen().includes(expected), 'Codex Unicode composer mismatch', 5000);
    backend.kill(); await pause(800);
    assert.ok(alive(cliPid), 'Codex must survive detach');
    terminal.dispose(); terminal = new xterm.Terminal({ cols: 160, rows: 40, allowProposedApi: true });
    backend = new ZellijBackend(name);
    backend.spawn(adapter.resolvedBin, args, opts);
    backend.onData(data => terminal.write(data)); backend.onExit(() => {});
    await until(() => screen().includes(expected), 'Codex composer lost on reattach');
    assert.equal(backend.getChildPid(), cliPid, 'same Codex launcher process');
    console.log('PASS Codex exact Unicode composer and same-process reattach; no prompt submitted.');
  } catch (error) {
    console.error(screen().slice(-2500)); throw error;
  } finally {
    backend.destroySession();
    await until(() => ZellijBackend.probeSession(name) === 'missing' && (!cliPid || !alive(cliPid)), 'CLI/session cleanup not confirmed', 10000);
    terminal.dispose();
  }
}
// node-pty's native helper can retain a handle after the short-lived version
// pane exits. All sessions and CLI PIDs were verified gone above.
process.exit(0);
