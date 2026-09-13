import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

export function isExecutable(path: string): boolean {
  try {
    // A directory can carry the `x` bit (it means "traversable"), so an X_OK
    // check alone would accept a directory that merely shares an executable's
    // name on PATH. Require a regular file (statSync follows symlinks, so a
    // symlink → real binary still qualifies) before trusting the mode bit.
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function locateExecutable(cmd: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!cmd) return null;
  if (process.platform === 'win32') {
    // npm installs both an extensionless POSIX shim and a .cmd launcher. Never
    // hand the POSIX shim to CreateProcess, even though X_OK succeeds on it.
    const getEnv = (name: string) => env[name]
      ?? env[Object.keys(env).find(key => key.toUpperCase() === name) ?? name];
    const extensions = (getEnv('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
      .split(';').filter(ext => /^\.(?:exe|com|cmd|bat)$/i.test(ext));
    if (extname(cmd) && !/^\.(?:exe|com|cmd|bat)$/i.test(extname(cmd))) return null;
    const names = extname(cmd) ? [cmd] : extensions.map(ext => cmd + ext.toLowerCase());
    const dirs = isAbsolute(cmd) || /[\\/]/.test(cmd)
      ? ['']
      : (getEnv('PATH') ?? '').split(';').filter(Boolean);
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = resolve(dir.replace(/^"(.*)"$/, '$1'), name);
        if (isExecutable(candidate)) return candidate;
      }
    }
    return null;
  }
  if (isAbsolute(cmd)) return isExecutable(cmd) ? cmd : null;
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, cmd);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}
