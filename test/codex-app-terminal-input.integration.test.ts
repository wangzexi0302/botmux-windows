import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { nodeTsRunnerPrefix, spawnNodeTsScript } from './helpers/ts-runner.js';
import { writeRunnerInput } from '../src/adapters/cli/runner-input.js';
import { CodexAppTurnDispatchQueue } from '../src/utils/codex-app-turn-dispatch.js';
import {
  CodexAppControlFinalAssembler,
  CodexAppControlLineDecoder,
  CodexAppControlSequenceFence,
  createCodexAppControlBootstrap,
  encodeCodexAppControlAccepted,
  encodeCodexAppControlAck,
  encodeCodexAppControlChallenge,
  generateCodexAppControlChallenge,
  generateCodexAppControlEpoch,
  generateCodexAppWindowsPipeEndpoint,
  parseCodexAppControlWireRecord,
  verifyCodexAppControlAuth,
  verifyCodexAppSignedControlMarker,
  writeCodexAppControlLocator,
} from '../src/utils/codex-app-control.js';

it('keeps mouse reports out of app-server and delivers the real Lark reply after the pre-flush Enter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bca-input-'));
  const sessionId = 'terminal-input-regression';
  const endpoint = process.platform === 'win32'
    ? generateCodexAppWindowsPipeEndpoint()
    : join(dir, 'control.sock');
  const epoch = generateCodexAppControlEpoch();
  const locatorPath = join(dir, 'locator.json');
  const bootstrap = createCodexAppControlBootstrap(dir, sessionId, process.platform === 'win32'
    ? { kind: 'locator', locatorPath }
    : endpoint);
  const requestLog = join(dir, 'requests.jsonl');
  // Node itself is a portable fake executable: `node app-server --listen ...`
  // loads this fixture in cwd on Windows too (no executable shebang/shell).
  writeFileSync(join(dir, 'app-server'),
    `process.argv.splice(2, 0, 'app-server');\nimport(${JSON.stringify(pathToFileURL(resolve('test/fixtures/fake-codex-app-server.mjs')).href)});`);
  const pending = new CodexAppTurnDispatchQueue();
  const finals: Array<Record<string, any>> = [];
  const settlements: unknown[] = [];
  const errors: string[] = [];
  const sockets = new Set<Socket>();
  let idleCount = 0;
  const server = createServer(socket => {
    sockets.add(socket);
    const challenge = generateCodexAppControlChallenge();
    const decoder = new CodexAppControlLineDecoder();
    const sequence = new CodexAppControlSequenceFence();
    const assembler = new CodexAppControlFinalAssembler();
    let authenticated = false;
    socket.on('error', error => errors.push(error.message));
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      for (const line of decoder.push(chunk).lines) {
        const record = parseCodexAppControlWireRecord(line);
        if (!record || record.sessionId !== sessionId) { errors.push('invalid session'); continue; }
        if (!authenticated) {
          if (record.type !== 'auth' || record.challenge !== challenge
              || record.generation !== bootstrap.identity.generation
              || !verifyCodexAppControlAuth(record, bootstrap.identity.publicKey)) {
            errors.push('invalid auth'); continue;
          }
          authenticated = true;
          socket.write(encodeCodexAppControlAccepted(sessionId, bootstrap.identity.generation, challenge,
            process.platform === 'win32' ? epoch : undefined) + '\n');
          continue;
        }
        if (record.type !== 'marker' || record.challenge !== challenge
            || record.generation !== bootstrap.identity.generation
            || !sequence.accept(record.seq)
            || !verifyCodexAppSignedControlMarker(record, bootstrap.identity.publicKey)) {
          errors.push('invalid marker'); continue;
        }
        const final = assembler.accept(record.kind, record.payload);
        if (final.status === 'reject') { errors.push(final.reason); continue; }
        if (final.status === 'accepted') continue;
        if (final.status === 'complete') {
          finals.push(final.payload);
          settlements.push(pending.settleFinal(final.payload));
        }
        if (record.kind === 'state' && record.payload.busy === false) idleCount++;
        socket.write(encodeCodexAppControlAck(sessionId, bootstrap.identity.generation, challenge, record.seq) + '\n');
      }
    });
    socket.write(encodeCodexAppControlChallenge(sessionId, challenge) + '\n');
  });
  server.listen(endpoint);
  await once(server, 'listening');
  if (process.platform === 'win32') {
    writeCodexAppControlLocator(locatorPath, { version: 1, sessionId, endpoint, epoch });
  }
  const child = spawnNodeTsScript(resolve('src/codex-app-runner.ts'), [
    '--session-id', sessionId,
    '--codex-bin', nodeTsRunnerPrefix().command,
    '--cwd', dir,
  ], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      BOTMUX_CODEX_APP_CONTROL_BOOTSTRAP: bootstrap.path,
      FAKE_CODEX_LOG: requestLog,
      FAKE_CODEX_BEHAVIOR: 'success',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk.toString(); });
  child.stderr!.on('data', chunk => { output += chunk.toString(); });
  child.on('error', error => errors.push(error.message));
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      if (Date.now() > deadline || child.exitCode !== null || errors.length) {
        throw new Error(`runner failed: ${errors.join('; ')}\n${output}`);
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
  };
  try {
    await waitFor(() => idleCount === 1);
    // Scroll, movement and focus arrive without Enter; writeRunnerInput then
    // sends the exact pre-flush that used to turn them into a model prompt.
    child.stdin!.write('\x1b[<65;11;43M\x1b[<35;12;43M\x1b[I\x1b[O');
    pending.reserve('om-real-chinese', 3);
    const text = '请检查中文消息，鼠标事件不应变成提问。';
    await writeRunnerInput({
      write: data => { child.stdin!.write(data); },
      sendText: data => { child.stdin!.write(data); return true; },
      sendSpecialKeys: () => { child.stdin!.write('\r'); return true; },
    }, '::botmux-codex-app:', text, undefined, 'om-real-chinese');
    await waitFor(() => finals.some(final => final.turnId === 'om-real-chinese') && idleCount >= 2);
    const starts = readFileSync(requestLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line)).filter(request => request.method === 'turn/start');
    expect(starts).toHaveLength(1);
    expect(starts[0].params.input).toEqual([expect.objectContaining({ type: 'text', text })]);
    expect(finals).toHaveLength(1);
    expect(settlements).toEqual([expect.objectContaining({ ok: true, turnId: 'om-real-chinese', dispatchAttempt: 3 })]);
    expect(pending.size()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
