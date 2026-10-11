import { describe, expect, it } from 'vitest';
import { codeFromHash, decodeCode, encodeCode, tryNowUrl } from '../../website/js/code-hash.js';

describe('code-hash', () => {
  it('round-trips ASCII source', () => {
    const src = 'program @ 0x0810 {\n  VIC2.borderColor = RED;\n  loop {}\n}\n';
    expect(decodeCode(encodeCode(src))).toBe(src);
  });

  it('round-trips non-ASCII characters and emoji', () => {
    const src = '// Cycle the colours — border → background 🌈\nprogram @ 0x0810 { loop {} }';
    expect(decodeCode(encodeCode(src))).toBe(src);
  });

  it('produces URL-safe output with no padding', () => {
    const encoded = encodeCode('???>>>~~~ÿÿÿ'.repeat(10));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
  });

  it('builds a try-now URL that codeFromHash reads back', () => {
    const src = 'program @ 0x0810 { loop {} }';
    const url = tryNowUrl(src, 'https://example.test/playground.html');
    const hash = url.slice(url.indexOf('#'));
    expect(url.startsWith('https://example.test/playground.html#code=')).toBe(true);
    expect(codeFromHash(hash)).toBe(src);
  });

  it('returns null for a missing, empty or unrelated hash', () => {
    expect(codeFromHash('')).toBeNull();
    expect(codeFromHash('#')).toBeNull();
    expect(codeFromHash('#about')).toBeNull();
    expect(codeFromHash('#code=')).toBeNull();
  });

  it('returns null (never throws) for malformed payloads', () => {
    expect(codeFromHash('#code=!!!not base64!!!')).toBeNull();
    expect(codeFromHash('#code=A')).toBeNull(); // impossible base64 length
    // 0xFF 0xFE is not valid UTF-8
    expect(codeFromHash('#code=__4')).toBeNull();
    expect(codeFromHash('#code=' + 'A'.repeat(100_001))).toBeNull(); // absurdly large
  });
});
