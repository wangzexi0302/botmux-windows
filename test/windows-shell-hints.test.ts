import { describe, expect, it } from 'vitest';
import { buildBotmuxShellHints, buildBotmuxSystemPromptText } from '../src/adapters/cli/shared-hints.js';

describe('platform shell routing for both CLI prompt styles', () => {
  for (const locale of ['zh', 'en'] as const) {
    it(`uses executable multiline guidance in ${locale}`, () => {
      const prompts = [buildBotmuxShellHints(locale).join('\n'), buildBotmuxSystemPromptText({ locale })];
      for (const prompt of prompts) {
        expect(prompt).toContain('--content-file');
        expect(prompt).toContain('JSON.stringify');
        if (process.platform === 'win32') {
          expect(prompt).toContain('PowerShell');
          expect(prompt).toContain('botmux.cmd send --no-mention --content-file $replyFile');
          expect(prompt).toContain('[Text.UTF8Encoding]::new($false)');
          expect(prompt).not.toContain('```bash');
        } else {
          expect(prompt).toContain("botmux send <<'EOF'");
          expect(prompt).not.toContain('botmux.cmd');
        }
      }
    });
    it(`keeps transport instructions out of transport-free sessions in ${locale}`, () => {
      for (const prompt of [buildBotmuxShellHints(locale, true).join('\n'), buildBotmuxSystemPromptText({ locale, noTransport: true })]) {
        expect(prompt).not.toContain('botmux.cmd');
        expect(prompt).not.toContain('--content-file');
      }
    });
  }
});
