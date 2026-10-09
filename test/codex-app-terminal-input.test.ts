import { describe, expect, it, vi } from 'vitest';
import { CodexAppTerminalInput } from '../src/utils/codex-app-terminal-input.js';
import { encodeRunnerInput, writeRunnerInput } from '../src/adapters/cli/runner-input.js';

function collect() {
  const lines: string[] = [];
  const interrupt = vi.fn();
  const input = new CodexAppTerminalInput(line => lines.push(line), interrupt);
  return { input, lines, interrupt, feed: (text: string) => input.write(Buffer.from(text)) };
}

describe('Codex App terminal input', () => {
  it.each([
    '\x1b[<65;11;43M', '\x1b[<35;12;44M', '\x1b[<0;11;43m',
    '\x1b[M !!', '\x1b[97;11;43M', '\x1b[I\x1b[O',
    '\x1b[A\x1b[1;5D\x1bOP', '\x1b[12;43R', '\x1b[?1;2c',
    '\x1b]10;rgb:ffff/ffff/ffff\x07', '\x1bP1$r0m\x1b\\',
  ])('discards %j at every byte split before the pre-flush Enter', report => {
    const bytes = Buffer.from(report);
    for (let split = 0; split <= bytes.length; split++) {
      const { input, lines, feed } = collect();
      input.write(bytes.subarray(0, split));
      input.write(bytes.subarray(split));
      feed('\r');
      feed('正常输入\r\n');
      expect(lines, `split ${split}`).toEqual(['正常输入']);
    }
  });

  it('preserves Chinese, emoji, tabs and literal sequence-like text across single-byte reads', () => {
    const { input, lines } = collect();
    for (const byte of Buffer.from('中文🙂\t[<65;11;43M\r\n')) input.write(Buffer.from([byte]));
    expect(lines).toEqual(['中文🙂\t[<65;11;43M']);
  });

  it('removes reports interleaved with text and ignores bracketed-paste wrappers', () => {
    const { feed, lines } = collect();
    feed('\x1b[200~你\x1b[<35;11;43M好\x1b[201~\r');
    expect(lines).toEqual(['你好']);
  });

  it('does not submit OSC payloads containing newlines as prompts', () => {
    const { feed, lines } = collect();
    feed('before\x1b]control\nnot a prompt\x1b\\after\r');
    expect(lines).toEqual(['beforeafter']);
  });

  it.each(['\x1b', '\x1b[', '\x1b[<65;11;', '\x1b[M '])('recovers a truncated report %j at Enter', report => {
    const { feed, lines } = collect();
    feed(report + '\r正常\r');
    expect(lines).toEqual(['正常']);
  });

  it('preserves backspace and interrupt without keeping other C0 controls', () => {
    const { feed, lines, interrupt } = collect();
    feed('中🙂\x7f文x\b\x00\x01\x07\r');
    expect(lines).toEqual(['中文']);
    feed('\x1b[\x03');
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it.each(['chunked', 'raw'] as const)('isolates terminal events from %s Botmux frame delivery', async mode => {
    const { feed, lines } = collect();
    feed('\x1b[<65;11;43M\x1b[<35;11;43M');
    const content = '中文\n\t🙂\x1b[<65;11;43M';
    const write = (text: string) => { feed(text); return true; };
    const pty = mode === 'raw' ? { write } : {
      write, sendText: write, sendSpecialKeys: () => write('\r'),
    };
    expect(await writeRunnerInput(pty, '::botmux-codex-app:', content, undefined, 'om-real'))
      .toMatchObject({ submitted: true });
    // Do not strip control-looking content INSIDE an encoded user message.
    expect(lines).toEqual(['::botmux-codex-app:' + encodeRunnerInput(content, undefined, 'om-real')]);
  });
});
