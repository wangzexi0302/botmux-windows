import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { WINDOWS_PROCESS_QUERY_TIMEOUT_MS } from './process-identity.js';

export interface WindowsProcessInfo {
  pid: number;
  parent: number;
  name: string;
  command: string;
  created: number;
}

let snapshot: { at: number; rows: WindowsProcessInfo[] } | undefined;

/** One bounded CIM snapshot per discovery pass, rather than spawning PowerShell
 * for every field of every process in the same tree. No shell-interpolated input. */
export function windowsProcesses(fresh = false): WindowsProcessInfo[] {
  if (!fresh && snapshot && Date.now() - snapshot.at < 1000) return snapshot.rows;
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); `
    + `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { `
    + `@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;name=$_.Name;command=$_.CommandLine;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()} })`;
  let rows: WindowsProcessInfo[] = [];
  try {
    const parsed: unknown = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
    }));
    if (Array.isArray(parsed)) rows = parsed.filter((p): p is WindowsProcessInfo => p
      && Number.isSafeInteger(p.pid) && p.pid > 0 && Number.isSafeInteger(p.parent)
      && typeof p.name === 'string' && Number.isFinite(p.created));
  } catch { /* unreadable process table is not proof of a matching CLI */ }
  snapshot = { at: Date.now(), rows };
  return rows;
}

/** ParentProcessId can outlive its parent and then name an unrelated process
 * that reused the PID. Such an old child predates the current parent's birth. */
export function windowsChildPids(pid: number, rows = windowsProcesses()): number[] {
  const parent = rows.find(p => p.pid === pid);
  if (!parent) return [];
  return rows.filter(p => p.parent === pid && p.created >= parent.created).map(p => p.pid);
}

/** A dead parent's PID may have been reused by a newer unrelated process. */
export function windowsParentPid(pid: number, rows = windowsProcesses()): number | null {
  const child = rows.find(p => p.pid === pid);
  if (!child) return null;
  const parent = rows.find(p => p.pid === child.parent);
  return parent && parent.created <= child.created ? parent.pid : null;
}

/** Windows command-line quoting, without invoking cmd or expanding %variables%. */
export function splitWindowsCommandLine(command: string): string[] {
  const args: string[] = [];
  let value = '', quoted = false, started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === '\\') {
      let count = 1;
      while (command[i + count] === '\\') count++;
      if (command[i + count] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) value += '"';
        else quoted = !quoted;
        i += count;
      } else { value += '\\'.repeat(count); i += count - 1; }
      started = true;
    } else if (ch === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(ch) && !quoted) {
      if (started) args.push(value);
      value = ''; started = false;
    } else { value += ch; started = true; }
  }
  // An incomplete command line cannot establish executable identity.
  if (quoted) return [];
  if (started) args.push(value);
  return args;
}

// The read-only PEB probe follows the x86/x64 process-parameter layout used by
// Windows' process inspection tools. Every read/length is checked; unsupported
// or inaccessible targets return no cwd. It never changes target memory.
const CWD_PROBE = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BotmuxProcessContext {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr address, byte[] bytes, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow64);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int kind, byte[] info, int length, out int returned);
  static byte[] Read(IntPtr h, long address, int length) {
    if(address <= 0 || length <= 0 || length > 65536) return null;
    var bytes = new byte[length]; IntPtr n;
    return ReadProcessMemory(h, new IntPtr(address), bytes, new IntPtr(length), out n) && n.ToInt64() == length ? bytes : null;
  }
  static long Ptr(byte[] b, int offset, bool x86) { return x86 ? BitConverter.ToUInt32(b, offset) : BitConverter.ToInt64(b, offset); }
  static string PaneId(IntPtr h, long address) {
    if(address <= 0) return null;
    var text = new StringBuilder(); bool zero = false;
    // Bounded reads stop at the environment terminator. Only the pane id is
    // returned to PowerShell/Node; provider credentials never leave this probe.
    for(int offset = 0; offset < 1048576; offset += 256) {
      var chunk = Read(h, address + offset, 256);
      if(chunk == null) return null;
      for(int i = 0; i < chunk.Length; i += 2) {
        char c = (char)BitConverter.ToUInt16(chunk, i);
        if(c == 0 && zero) {
          foreach(var entry in text.ToString().Split('\0')) {
            if(entry.StartsWith("ZELLIJ_PANE_ID=", StringComparison.OrdinalIgnoreCase)) return entry.Substring(15);
          }
          return null;
        }
        text.Append(c); zero = c == 0;
      }
    }
    return null;
  }
  public static string[] ReadContext(int pid) {
    var h = OpenProcess(0x410, false, pid);
    if(h == IntPtr.Zero) return null;
    try {
      if(IntPtr.Size != 8) return null;
      bool x86; if(!IsWow64Process(h, out x86)) return null;
      var info = new byte[x86 ? 8 : 48]; int returned;
      if(NtQueryInformationProcess(h, x86 ? 26 : 0, info, info.Length, out returned) != 0) return null;
      long peb = BitConverter.ToInt64(info, x86 ? 0 : 8);
      var paramAddress = Read(h, peb + (x86 ? 0x10 : 0x20), x86 ? 4 : 8);
      if(paramAddress == null) return null;
      long parameters = Ptr(paramAddress, 0, x86);
      var descriptor = Read(h, parameters + (x86 ? 0x24 : 0x38), x86 ? 8 : 16);
      if(descriptor == null) return null;
      int length = BitConverter.ToUInt16(descriptor, 0), max = BitConverter.ToUInt16(descriptor, 2);
      if(length == 0 || length > max || length % 2 != 0) return null;
      var text = Read(h, Ptr(descriptor, x86 ? 4 : 8, x86), length);
      long created, exited, kernel, user;
      if(text == null || !GetProcessTimes(h, out created, out exited, out kernel, out user)) return null;
      var environment = Read(h, parameters + (x86 ? 0x48 : 0x80), x86 ? 4 : 8);
      string pane = environment == null ? null : PaneId(h, Ptr(environment, 0, x86));
      return new string[]{Encoding.Unicode.GetString(text), pane, new DateTimeOffset(DateTime.FromFileTimeUtc(created)).ToUnixTimeMilliseconds().ToString()};
    } finally { CloseHandle(h); }
  }
}`;

export function windowsProcessContext(pid: number): { cwd: string; paneId?: string; created: number } | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -TypeDefinition @'\n${CWD_PROBE}\n'@; $v=[BotmuxProcessContext]::ReadContext(${pid}); if($v){ConvertTo-Json -Compress -InputObject @{cwd=$v[0];paneId=$v[1];created=[long]$v[2]}}`;
  try {
    const out = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
    }));
    if (typeof out.cwd !== 'string' || !win32.isAbsolute(out.cwd) || out.cwd.includes('\0') || !Number.isFinite(out.created)) return undefined;
    const pane = typeof out.paneId === 'string' ? out.paneId.match(/^(?:terminal_)?(\d+)$/) : null;
    return { cwd: realpathSync.native(out.cwd), paneId: pane ? `terminal_${pane[1]}` : undefined, created: out.created };
  } catch { return undefined; }
}

export function windowsProcessCwd(pid: number): string | undefined {
  return windowsProcessContext(pid)?.cwd;
}
