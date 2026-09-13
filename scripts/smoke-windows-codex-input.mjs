// Exercises the real Codex composer without submitting a prompt to a model.
// Optional first argument selects a particular installed Codex executable.
import xterm from '@xterm/headless';
import { PtyBackend } from '../dist/adapters/backend/pty-backend.js';
import { createCliAdapterSync } from '../dist/adapters/cli/registry.js';

if (process.platform !== 'win32') throw new Error('Run on native Windows.');
const adapter = createCliAdapterSync('codex', process.argv[2]);
const terminal = new xterm.Terminal({ cols: 160, rows: 40, allowProposedApi: true });
const backend = new PtyBackend();
const expected = 'BOTMUX-UNICODE 中文“引号”——→→ 😀😀 café a&b %PATH% DONE';
let exited = false;
const screen = () => {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n');
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error('Codex exited before the composer check');
    if (predicate()) return;
    await pause(100);
  }
  throw new Error(`Composer check timed out:\n${screen().slice(-2000)}`);
}
let result = 0;
try {
  backend.spawn(adapter.resolvedBin, ['--no-alt-screen', '-c', 'check_for_update_on_startup=false'], {
    cwd: process.cwd(), cols: 160, rows: 40, env: { ...process.env, TERM: 'xterm-256color' },
  });
  backend.onData(data => terminal.write(data));
  backend.onExit(() => { exited = true; });
  await until(() => /│\s+model:\s+(?!loading\b)\S/.test(screen()) && /›/.test(screen()), 25_000);
  backend.write(`\x1b[200~${expected}\x1b[201~`);
  await until(() => screen().includes(expected), 5_000);
  console.log('Codex native Windows composer preserves Unicode, repeated punctuation and shell characters; no prompt submitted.');
} catch (error) {
  console.error(error.message);
  result = 1;
} finally {
  backend.kill();
  const deadline = Date.now() + 5_000;
  while (!exited && Date.now() < deadline) await pause(50);
  if (!exited) { console.error('Codex cleanup was not confirmed'); result = 1; }
  terminal.dispose();
}
process.exit(result);
