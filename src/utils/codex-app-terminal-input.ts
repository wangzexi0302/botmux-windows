import { StringDecoder } from 'node:string_decoder';

type EscapeState = 'text' | 'escape' | 'csi' | 'ss3' | 'intermediate' | 'string' | 'string-escape' | 'mouse';

/**
 * Codex App's stdin is a terminal byte stream, not just lines of user text.
 * Keep parser state across reads: mouse/focus/key reports and UTF-8 characters
 * can both be split at any byte. Only text reaches the runner's line queue;
 * the ASCII Botmux/base64 envelope is passed through without decoding it here.
 */
export class CodexAppTerminalInput {
  private readonly decoder = new StringDecoder('utf8');
  private line = '';
  private state: EscapeState = 'text';
  private csiHasParameters = false;
  private mouseRemaining = 0;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onInterrupt: () => void,
  ) {}

  write(data: Buffer): void {
    for (const ch of this.decoder.write(data)) this.accept(ch);
  }

  private accept(ch: string): void {
    if (ch === '\x03') {
      this.onInterrupt();
      return;
    }
    // OSC/DCS/APC/PM strings can contain newlines; none of their payload is a
    // prompt. Unlike CSI, only BEL/ST terminates these control strings.
    if (this.state === 'string' || this.state === 'string-escape') {
      if (ch === '\x07' || ch === '\x9c' || (this.state === 'string-escape' && ch === '\\')) {
        this.state = 'text';
      } else {
        this.state = ch === '\x1b' ? 'string-escape' : 'string';
      }
      return;
    }
    // Enter also terminates an incomplete key/mouse report, so a pre-flush
    // cannot leave an escape prefix that eats the next Botmux control frame.
    if (ch === '\r' || ch === '\n') {
      const line = this.line;
      this.line = '';
      this.state = 'text';
      if (line.trim()) this.onLine(line);
      return;
    }
    if (ch === '\x1b') { this.state = 'escape'; return; }
    if (ch === '\x9b') { this.state = 'csi'; this.csiHasParameters = false; return; }
    if (this.state === 'mouse') {
      if (--this.mouseRemaining === 0) this.state = 'text';
      return;
    }
    if (this.state === 'escape') {
      if (ch === '[') { this.state = 'csi'; this.csiHasParameters = false; }
      else if (ch === 'O') this.state = 'ss3';
      else if (']P^_X'.includes(ch)) this.state = 'string';
      else if (ch >= ' ' && ch <= '/') this.state = 'intermediate';
      else this.state = 'text';
      return;
    }
    if (this.state === 'csi' || this.state === 'ss3') {
      if (ch >= '@' && ch <= '~') {
        // Legacy X10 mouse packets have three trailing encoded coordinates;
        // treating CSI M as their end would leak those bytes as ordinary text.
        if (this.state === 'csi' && ch === 'M' && !this.csiHasParameters) {
          this.state = 'mouse';
          this.mouseRemaining = 3;
        } else this.state = 'text';
      } else this.csiHasParameters = true;
      return;
    }
    if (this.state === 'intermediate') {
      if (ch >= '0' && ch <= '~') this.state = 'text';
      return;
    }
    if (ch === '\x7f' || ch === '\b') {
      const chars = Array.from(this.line);
      chars.pop();
      this.line = chars.join('');
    } else if (ch === '\t' || (ch >= ' ' && !(ch >= '\x80' && ch <= '\x9f'))) {
      this.line += ch;
    }
  }
}
