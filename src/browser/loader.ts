export type Source = string | ArrayBuffer | Uint8Array | Blob;

export class LoadError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `failed to load ${url}: HTTP ${status}`);
    this.name = 'LoadError';
  }
}

export async function toBytes(src: Source): Promise<Uint8Array> {
  if (typeof src === 'string') {
    let res: Response;
    try {
      res = await fetch(src);
    } catch (error) {
      throw new LoadError(src, 0, `failed to load ${src}: ${(error as Error).message}`);
    }
    if (!res.ok) throw new LoadError(src, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  return new Uint8Array(await src.arrayBuffer());
}
