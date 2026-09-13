import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isExecutable, locateExecutable } from './executable.js';

/** Resolve npm's Windows .cmd shim to Node + its JS entry, preserving argv.
 * Going through cmd.exe would interpret prompt text, %, &, and quotes as shell
 * syntax. Native executables and every POSIX launch retain their original argv.
 * Arbitrary batch programs need an explicit native executable wrapper instead.
 */
export function resolvePtyLaunch(
  bin: string, args: string[], env: NodeJS.ProcessEnv,
): { bin: string; args: string[] } {
  if (process.platform !== 'win32') return { bin, args };
  const resolved = locateExecutable(bin, env) ?? bin;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { bin: resolved, args };
  const shim = readFileSync(resolved, 'utf8');
  // Only the standard npm cmd-shim Node invocation is supported. Do not eval
  // arbitrary batch files, or guess a package entry from the command's name.
  const entry = shim.match(/"%_prog%"\s+"%dp0%[\\/]([^"\r\n]+\.(?:[cm]?js))"\s+%\*/i)?.[1];
  if (!entry) {
    throw new Error(`Windows PTY cannot launch this batch file: ${resolved}. Use a native .exe or an npm Node.js launcher.`);
  }
  const script = resolve(dirname(resolved), entry);
  if (!isExecutable(script)) throw new Error(`npm launcher entry is missing: ${script}`);
  const siblingNode = join(dirname(resolved), 'node.exe');
  const node = isExecutable(siblingNode) ? siblingNode : locateExecutable('node', env);
  if (!node) throw new Error(`Node.js is required by the npm launcher: ${resolved}`);
  return { bin: node, args: [script, ...args] };
}
