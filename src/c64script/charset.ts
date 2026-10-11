// Character literals and string literals mean C64 *screen codes*: the byte you store in
// screen RAM ($0400) to show a character with the power-on (uppercase) character set.
// A=1 … Z=26, space and ASCII punctuation/digits 32–63 keep their ASCII value, @=0.
// Lowercase is refused: its screen code depends on which character set is active.

export type ScreenCode = { readonly code: number } | { readonly error: string };

export function screenCodeOf(ch: string): ScreenCode {
  if (ch >= 'A' && ch <= 'Z') return { code: ch.charCodeAt(0) - 64 };
  if (ch >= ' ' && ch <= '?') return { code: ch.charCodeAt(0) };
  if (ch === '@') return { code: 0 };
  if (ch === '[') return { code: 27 };
  if (ch === ']') return { code: 29 };
  if (ch >= 'a' && ch <= 'z') {
    return {
      error: `lowercase '${ch}' depends on the active character set; use '${ch.toUpperCase()}'`,
    };
  }
  return { error: `no screen code for '${ch}'` };
}
