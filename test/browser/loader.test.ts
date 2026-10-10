import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadError, toBytes } from '../../src/browser/loader';

afterEach(() => vi.unstubAllGlobals());

describe('toBytes', () => {
  it('passes Uint8Array through, wraps ArrayBuffer, reads Blob', async () => {
    const u8 = Uint8Array.from([1, 2, 3]);
    expect(await toBytes(u8)).toBe(u8);
    expect([...(await toBytes(u8.buffer))]).toEqual([1, 2, 3]);
    expect([...(await toBytes(new Blob([u8])))]).toEqual([1, 2, 3]);
  });

  it('fetches URLs', async () => {
    vi.stubGlobal('fetch', async () => new Response(Uint8Array.from([9, 8]), { status: 200 }));
    expect([...(await toBytes('http://x/y.prg'))]).toEqual([9, 8]);
  });

  it('rejects non-2xx with LoadError carrying URL and status', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    await expect(toBytes('http://x/missing.prg')).rejects.toMatchObject({
      name: 'LoadError',
      status: 404,
      url: 'http://x/missing.prg',
    });
    await expect(toBytes('http://x/missing.prg')).rejects.toBeInstanceOf(LoadError);
  });

  it('wraps network failures as LoadError with status 0', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network down');
    });
    await expect(toBytes('http://x/y')).rejects.toMatchObject({ name: 'LoadError', status: 0 });
  });
});
