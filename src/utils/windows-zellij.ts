import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { locateExecutable } from './executable.js';
import { resolveExecutableLaunch } from './pty-launch.js';
import { applySessionOwnerEnv } from './child-env.js';
import { encodeWindowsPtyInput } from './windows-pty-input.js';
import { resolveBotmuxWrapperBinDir } from '../core/botmux-wrapper.js';
import type { SpawnOpts } from '../adapters/backend/types.js';
import { zellijEnv } from '../setup/ensure-zellij.js';

// A pane-local launcher, not a server-global env override. Inline source also
// works in compiled builds, without referencing a virtual dist/ file. The
// native child inherits Zellij's console directly, not an extra PTY.
export const WINDOWS_ZELLIJ_RUNNER = `/* botmux-zellij-pane */
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const spec=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
fs.unlinkSync(process.argv[1]);
const child=spawn(spec.bin,spec.args,{cwd:spec.cwd,env:spec.env,stdio:'inherit',windowsHide:true});
process.on('SIGINT',()=>{});
child.on('error',e=>{console.error('Botmux pane launch failed: '+e.message);process.exit(1)});
child.on('exit',code=>process.exit(code??1));
`;

export function buildWindowsZellijPane(bin: string, args: string[], opts: SpawnOpts, bootstrapFile: string): { bin: string; args: string[]; bootstrap: string } {
  const env: NodeJS.ProcessEnv = {};
  // Windows env keys are case-insensitive; avoid PATH/Path and owner aliases.
  for (const source of [opts.env, opts.injectEnv ?? {}]) {
    for (const [key, value] of Object.entries(source)) env[key.toUpperCase()] = value;
  }
  applySessionOwnerEnv(env, opts.env.BOTMUX_OWNER_OPEN_ID);
  const launch = resolveExecutableLaunch(bin, args, env);
  const node = locateExecutable('node', env) ?? (process.versions.bun ? undefined : process.execPath);
  if (!node) throw new Error('Native Windows Zellij requires Node.js on PATH.');
  env.PATH = `${resolveBotmuxWrapperBinDir(opts.env)};${env.PATH ?? ''}`;
  env.DISABLE_AUTO_UPDATE = 'true';
  // Only this one-shot file path enters argv/layout/cache. Provider credentials
  // and long prompts must not enter Zellij's persistent layout or hit Win32's
  // 32K command-line limit. The pane launcher consumes and unlinks the file.
  const bootstrap = JSON.stringify({ ...launch, cwd: opts.cwd, env });
  return { bin: node, args: ['-e', WINDOWS_ZELLIJ_RUNNER, bootstrapFile], bootstrap };
}

/** Address the inner ConPTY directly. Sending Unicode through the attached
 * client would cross two keyboard decoders and lose punctuation in native
 * Codex. Numeric bytes also preserve NUL, quotes and newlines in Windows argv.
 * Do not retry a failed chunk: a timeout can mean it was already delivered. */
export function writeWindowsZellijInput(session: string, data: string, paneId?: string | null): void {
  const bytes = Buffer.from(encodeWindowsPtyInput(data), 'utf8');
  const env = zellijEnv();
  for (let offset = 0; offset < bytes.length; offset += 2048) {
    execFileSync('zellij', [
      '--session', session, 'action', 'write',
      ...(paneId ? ['--pane-id', paneId] : []),
      ...Array.from(bytes.subarray(offset, offset + 2048), String),
    ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  }
}

interface WindowsProcess { pid: number; parent: number; name: string; command: string; created: number }

/** Only return the requested process and its descendants, never an unrelated
 * command line. The PID is validated numerically before entering PowerShell. */
function processTree(pid: number): WindowsProcess[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); `
    + `$all=@(Get-CimInstance Win32_Process); $ids=@(${pid}); $rows=@(); `
    + `for($depth=0;$depth -lt 5 -and $ids.Count -gt 0;$depth++){ `
    + `$rows+=@($all | Where-Object { $ids -contains [int]$_.ProcessId }); `
    + `$ids=@($all | Where-Object { $ids -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId }) }; `
    + `ConvertTo-Json -Compress -InputObject @($rows | ForEach-Object { `
    + `@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;name=$_.Name;command=$_.CommandLine;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()} })`;
  try {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
    }));
  } catch { return []; }
}

/** Windows Zellij writes its server PID into the socket discovery file. Check
 * process identity and creation time as well, so stale files/PID reuse cannot
 * attribute a different session. Renamed sessions fail closed here. */
export function findWindowsZellijProcess(session: string, cli: boolean): number | null {
  if (!session || /[\\/\x00]/.test(session) || session === '.' || session === '..') return null;
  try {
    const root = realpathSync(process.env.ZELLIJ_SOCKET_DIR ?? join(tmpdir(), 'zellij'));
    const matches: number[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^contract_version_\d+$/.test(entry.name)) continue;
      const marker = join(root, entry.name, session);
      let pid: number; let modified: number;
      try { pid = Number(readFileSync(marker, 'utf8').trim()); modified = statSync(marker).mtimeMs; } catch { continue; }
      const tree = processTree(pid);
      const server = tree.find(p => p.pid === pid);
      if (!server || server.name?.toLowerCase() !== 'zellij.exe' || server.created > modified) continue;
      const arg = server.command?.match(/(?:^|\s)--server\s+(?:"([^"]+)"|(\S+))/);
      if (!arg || win32.normalize(arg[1] ?? arg[2]!).toLowerCase() !== win32.normalize(marker).toLowerCase()) continue;
      if (!cli) { matches.push(pid); continue; }
      const runners = tree.filter(p => p.parent === pid && p.name?.toLowerCase() === 'node.exe'
        && p.command?.includes('/* botmux-zellij-pane */'));
      if (runners.length !== 1) continue;
      const children = tree.filter(p => p.parent === runners[0]!.pid && p.name?.toLowerCase() !== 'conhost.exe');
      if (children.length === 1) matches.push(children[0]!.pid);
    }
    return matches.length === 1 ? matches[0]! : null;
  } catch { return null; }
}
