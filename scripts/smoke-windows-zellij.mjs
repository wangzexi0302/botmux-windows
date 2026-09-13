// Real native Zellij: Unicode input, pane-local env, resize, worker death,
// reattach to the SAME CLI process, and explicit close. No model calls.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZellijBackend } from '../dist/adapters/backend/zellij-backend.js';
import { probeZellijFunctional } from '../dist/setup/ensure-zellij.js';

if (process.platform !== 'win32') throw new Error('Run on native Windows with Node.js.');
assert.deepEqual(probeZellijFunctional().ok, true, 'Zellij functional probe');
const dir = mkdtempSync(join(tmpdir(), 'bmx-zellij-smoke-'));
const cwd = join(dir, '原生 Windows');
mkdirSync(cwd);
const name = `bmx-winsmoke-${process.pid}-${Date.now()}`;
const report = join(dir, 'report.json');
const fixture = join(cwd, 'fixture.cjs');
const hostFile = join(dir, 'host.mjs');
const arg = '中文“引号”——→→ 😀😀 café a&b %PATH% "quoted"';
writeFileSync(fixture, `
const fs=require('node:fs');
let data='';
const save=()=>fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2),cwd:process.cwd(),owner:process.env.BOTMUX_OWNER_OPEN_ID,legacy:process.env.__OWNER_OPEN_ID,env:process.env.BMX_TEST_VALUE,cols:process.stdout.columns,rows:process.stdout.rows,data}));
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
process.stdin.on('data',s=>{data+=s;save();console.log('INPUT:'+s)});
process.stdout.on('resize',save);save();console.log('BMX_READY');setInterval(()=>{},1000);
`);
writeFileSync(hostFile, `
import {ZellijBackend} from ${JSON.stringify(new URL('../dist/adapters/backend/zellij-backend.js', import.meta.url).href)};
const be=new ZellijBackend(${JSON.stringify(name)});
process.on('message',msg=>{
 try {
  if(msg.type==='start') {be.spawn(process.execPath,[${JSON.stringify(fixture)},${JSON.stringify(arg)}],{cwd:${JSON.stringify(cwd)},cols:120,rows:30,env:{...process.env,BOTMUX_OWNER_OPEN_ID:'test-owner'},injectEnv:{BMX_TEST_VALUE:${JSON.stringify(arg + '\nsecond line')},BOTMUX_OWNER_OPEN_ID:'wrong',__OWNER_OPEN_ID:'wrong'}});be.onData(()=>{});be.onExit(()=>{});}
  if(msg.type==='input') be.write(msg.data);
  if(msg.type==='resize') be.resize(msg.cols,msg.rows);
  if(msg.type==='pid') process.send({id:msg.id,pid:be.getChildPid(),reattach:be.isReattach});
  if(msg.type==='detach') {be.kill();process.send({id:msg.id});setTimeout(()=>process.exit(),500);return;}
  if(msg.type==='close') {be.destroySession();process.send({id:msg.id});setTimeout(()=>process.exit(),500);return;}
  if(msg.type!=='pid') process.send({id:msg.id});
 }catch(e){process.send({id:msg.id,error:e.stack});}
});
`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await pause(100); }
  throw new Error(message);
}
function readReport() { try { return JSON.parse(readFileSync(report, 'utf8')); } catch { return {}; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
let host; let seq = 0; const allHosts = [];
function startHost() {
  host = spawn(process.execPath, [hostFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  allHosts.push(host);
  host.stderr.on('data', d => process.stderr.write(d));
  return request('start');
}
function request(type, extra = {}) {
  const target = host; const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${type} request timed out`)); }, 20000);
    const listener = msg => { if (msg.id !== id) return; cleanup(); msg.error ? reject(new Error(msg.error)) : resolve(msg); };
    function cleanup() { clearTimeout(timer); target.off('message', listener); }
    target.on('message', listener); target.send({ type, id, ...extra });
  });
}
let cliPid;
try {
  await startHost();
  await until(() => Boolean(readReport().pid), 'native fixture did not start');
  cliPid = readReport().pid;
  assert.equal(readReport().cwd.toLowerCase(), cwd.toLowerCase());
  assert.deepEqual(readReport().argv, [arg]);
  assert.equal(readReport().env, arg + '\nsecond line');
  assert.equal(readReport().owner, 'test-owner');
  assert.equal(readReport().legacy, 'test-owner');
  await until(async () => (await request('pid')).pid === cliPid, 'native CLI PID discovery');
  const first = '\x1b[200~' + arg + '\n' + '中文——'.repeat(250) + '\x1b[201~';
  await request('input', { data: first });
  await until(() => readReport().data === first, 'Unicode / multiline / chunked input mismatch');
  await request('resize', { cols: 99, rows: 32 });
  await until(() => readReport().cols === 99 && readReport().rows === 32, 'pane resize not delivered');
  await request('detach');
  await until(() => host.exitCode !== null, 'first host did not exit');
  assert.ok(alive(cliPid), 'CLI must survive graceful detach');
  await startHost();
  assert.deepEqual(await request('pid').then(r => [r.pid, r.reattach]), [cliPid, true]);
  await request('input', { data: 'AFTER_DETACH' });
  await until(() => readReport().data.endsWith('AFTER_DETACH'), 'reattached input missing');
  host.kill();
  await until(() => host.exitCode !== null || host.signalCode !== null, 'second host did not die');
  assert.ok(alive(cliPid), 'CLI must survive unexpected worker death');
  await startHost();
  assert.deepEqual(await request('pid').then(r => [r.pid, r.reattach]), [cliPid, true]);
  await request('input', { data: 'AFTER_CRASH' });
  await until(() => readReport().data.endsWith('AFTER_CRASH'), 'post-crash input missing');
  await request('close');
  await until(() => !alive(cliPid), 'explicit close left the CLI running');
  assert.equal(ZellijBackend.probeSession(name), 'missing');
  console.log('PASS native Zellij: exact argv/env/owner, Unicode input, resize, graceful detach, worker crash, same-PID reattach, explicit close.');
} catch (error) {
  // Keep CI failures inspectable without printing unrelated processes or env.
  const root = process.env.ZELLIJ_SOCKET_DIR ?? join(tmpdir(), 'zellij');
  try {
    console.error('Zellij discovery root:', root, 'canonical:', realpathSync(root));
    for (const entry of readdirSync(root)) {
      if (!/^contract_version_\d+$/.test(entry)) continue;
      const marker = join(root, entry, name);
      try { console.error('Zellij marker:', marker, 'PID:', readFileSync(marker, 'utf8'), 'modified:', statSync(marker).mtimeMs); } catch {}
    }
    if (Number.isSafeInteger(cliPid) && cliPid > 0) {
      const script = `$all=@(Get-CimInstance Win32_Process); $next=${cliPid}; $rows=@(); for($depth=0;$depth -lt 4;$depth++){ $p=$all | Where-Object ProcessId -eq $next | Select-Object -First 1; if(!$p){break}; $rows+=@{pid=$p.ProcessId;parent=$p.ParentProcessId;name=$p.Name;created=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();server=if($p.Name -eq 'zellij.exe' -and $p.CommandLine -match '--server'){$p.CommandLine}else{''}}; $next=$p.ParentProcessId }; ConvertTo-Json -Compress -InputObject $rows`;
      console.error('Fixture ancestors:', execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 20000 }));
    }
  } catch (diagnosticError) { console.error('Discovery diagnostic failed:', diagnosticError.message); }
  throw error;
} finally {
  for (const child of allHosts) if (child.exitCode === null && child.signalCode === null) child.kill();
  ZellijBackend.killSession(name);
  await pause(1500);
  if (!cliPid || !alive(cliPid)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  else console.error(`Fixture still alive; diagnostic directory retained: ${dir}`);
}
