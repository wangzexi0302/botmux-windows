/** ConPTY maps some BMP characters (smart quotes, dashes, arrows) through
 * keyboard-layout events that native console readers can discard. Send those
 * code units as explicit Unicode key events using Microsoft's win32-input-mode.
 * Key-up prevents repeated characters being coalesced into a repeat count that
 * some readers ignore. Keep surrogate pairs together on the normal UTF-8 path.
 * ASCII, including VT controls and bracketed-paste delimiters, stays unchanged.
 * https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md
 */
export function encodeWindowsPtyInput(data: string): string {
  let encoded = '';
  for (const character of data) {
    const unit = character.charCodeAt(0);
    encoded += unit > 0x7f && character.length === 1 && !(unit >= 0xd800 && unit <= 0xdfff)
      ? `\x1b[0;0;${unit};1;0;1_\x1b[0;0;${unit};0;0;1_`
      : character;
  }
  return encoded;
}
