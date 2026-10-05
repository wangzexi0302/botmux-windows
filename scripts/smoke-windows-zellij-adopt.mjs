// Native pane discovery and targeted input, using two controlled CLI-shaped
// processes in the SAME cwd. No authentication, model calls or user sessions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZellijBackend } from '../dist/adapters/backend/zellij-backend.js';
import { ZellijObserveBackend } from '../dist/adapters/backend/zellij-observe-backend.js';
import { discoverAdoptableZellijSessions, validateZellijAdoptTarget } from '../dist/core/zellij-adopt-discovery.js';

if (process.platform !== 'win32' || process.versions.bun) throw new Error('Run with Node on native Windows.');
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bmx-adopt-smoke-')));
const cwd = join(root, '同一工作目录 😀'); mkdirSync(cwd);
const fixture = join(cwd, 'codex.cjs');
const launcher = join(cwd, 'codex.cmd');
writeFileSync(launcher, '@echo off\r\n"%_prog%" "%dp0%\\codex.cjs" %*\r\n');
const reports = [join(root, 'first.json'), join(root, 'second.json')];
const duplicateReport = join(root, 'duplicate.json');
const name = `win-adopt-smoke-${process.pid}-${Date.now()}`;
const backend = new ZellijBackend(name);
let observer;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } };
async function until(predicate, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await pause(100); }
  throw new Error(message);
}
writeFileSync(fixture, `const fs=require('node:fs');if(process.argv[3])process.env.ZELLIJ_PANE_ID=process.argv[3];let data='';const save=()=>fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,pane:process.env.ZELLIJ_PANE_ID,data}));process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{data+=s;save();process.stdout.write('INPUT:'+s)});save();console.log('ADOPT_READY');setInterval(()=>{},1000);`);
try {
  backend.spawn(process.execPath, [fixture, reports[0]], { cwd, cols: 120, rows: 30, env: { ...process.env } });
  backend.onData(() => {}); backend.onExit(() => {});
  await until(() => read(reports[0]).pid, 'first pane did not start');
  execFileSync('zellij', ['--session', name, 'action', 'new-pane', '--cwd', cwd, '--', process.execPath, fixture, reports[1]], { windowsHide: true, timeout: 10000, stdio: 'pipe' });
  await until(() => read(reports[1]).pid, 'second pane did not start');
  const panes = discoverAdoptableZellijSessions('codex').filter(p => p.zellijSession === name);
  assert.equal(panes.length, 2, 'both same-cwd CLI panes must be adoptable');
  const exact = discoverAdoptableZellijSessions('codex', launcher).filter(p => p.zellijSession === name);
  assert.deepEqual(exact.map(p => p.cliPid).sort(), panes.map(p => p.cliPid).sort(), 'npm launcher maps to its exact JS entry');
  const otherDir = join(root, 'other'); mkdirSync(otherDir);
  writeFileSync(join(otherDir, 'codex.cmd'), '@echo off\r\n"%_prog%" "%dp0%\\codex.cjs" %*\r\n');
  writeFileSync(join(otherDir, 'codex.cjs'), '');
  assert.equal(discoverAdoptableZellijSessions('codex', join(otherDir, 'codex.cmd')).filter(p => p.zellijSession === name).length, 0, 'same launcher basename from another distribution must not match');
  for (const report of reports) {
    const state = read(report);
    const pane = panes.find(p => p.cliPid === state.pid);
    assert.ok(pane, 'exact native process found');
    assert.equal(pane.zellijPaneId, `terminal_${state.pane}`);
    assert.equal(pane.cwd.toLowerCase(), cwd.toLowerCase());
    assert.ok(validateZellijAdoptTarget(name, pane.zellijPaneId, state.pid, 'codex'));
    const other = panes.find(p => p.cliPid !== state.pid);
    assert.equal(validateZellijAdoptTarget(name, other.zellijPaneId, state.pid, 'codex'), false, 'wrong-pane PID must be rejected');
  }
  const first = panes.find(p => p.cliPid === read(reports[0]).pid);
  observer = new ZellijObserveBackend(name, first.zellijPaneId, { cliPid: first.cliPid });
  const text = '接管 中文“引号”——→→ 😀😀 café a&b %PATH%';
  assert.ok(observer.pasteText(text));
  await until(() => read(reports[0]).data === '\x1b[200~' + text + '\x1b[201~', 'adopt Unicode input mismatch');
  assert.equal(read(reports[1]).data, '', 'input must not reach the second pane');
  observer.destroySession();
  assert.ok(reports.every(path => alive(read(path).pid)), 'observer detach must preserve both processes');
  execFileSync('zellij', ['--session', name, 'action', 'new-pane', '--cwd', cwd, '--', process.execPath, fixture, duplicateReport, String(read(reports[0]).pane)], { windowsHide: true, timeout: 10000, stdio: 'pipe' });
  await until(() => read(duplicateReport).pid, 'duplicate-identifier fixture did not start');
  const ambiguous = discoverAdoptableZellijSessions('codex').filter(p => p.zellijSession === name);
  assert.deepEqual(ambiguous.map(p => p.cliPid), [read(reports[1]).pid], 'duplicate pane identifiers must be refused');
  assert.equal(validateZellijAdoptTarget(name, first.zellijPaneId, first.cliPid, 'codex'), false, 'confirmation also refuses ambiguity');
  console.log('PASS native Zellij adopt: same-cwd panes, exact PID/pane validation, wrong-pane refusal, targeted Unicode, detach preserves sessions.');
} catch (error) {
  console.error('Owned fixture input:', reports.map(path => read(path)));
  throw error;
} finally {
  observer?.kill(); backend.destroySession();
  await until(() => [...reports, duplicateReport].every(path => !read(path).pid || !alive(read(path).pid)), 'owned smoke process cleanup failed', 10000);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(0);
