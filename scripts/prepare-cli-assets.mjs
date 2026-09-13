import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';

// Node APIs work under both PowerShell and POSIX shells. Windows does not
// require (or provide) chmod to execute the generated JavaScript through Node.
mkdirSync(new URL('../dist/setup/', import.meta.url), { recursive: true });
copyFileSync(
  new URL('../src/setup/lark-scopes.json', import.meta.url),
  new URL('../dist/setup/lark-scopes.json', import.meta.url),
);
if (process.platform !== 'win32') chmodSync(new URL('../dist/cli.js', import.meta.url), 0o755);
