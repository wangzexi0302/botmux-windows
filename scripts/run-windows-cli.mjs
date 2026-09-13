import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// node-pty's ConPTY transport has been verified under Node. Bun 1.4.2 aborted
// a real Codex --version session with STATUS_CONTROL_C_EXIT on Windows.
// Keep the build tool separate from the Windows daemon/worker interpreter.
if (process.platform !== 'win32' || process.versions.bun) {
  console.error('Run this Windows entry with Node.js: bun run windows:cli <command>');
  process.exit(1);
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('Windows botmux requires Node.js >= 22.13 (including node:sqlite).');
  process.exit(1);
}
const entry = new URL('../dist/cli.js', import.meta.url);
if (!existsSync(entry)) {
  console.error('Build botmux first: bun run build');
  process.exit(1);
}
process.argv = [process.execPath, fileURLToPath(entry), ...process.argv.slice(2)];
await import(entry.href);
