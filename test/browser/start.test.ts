import { afterEach, describe, expect, it, vi } from 'vitest';
import { start } from '../../src/browser/player';
import { filled } from '../machine/helpers';

class FakeTarget {
  readonly listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  has(type: string): boolean {
    return (this.listeners.get(type) ?? []).length > 0;
  }
}

function fakeCanvas() {
  const target = new FakeTarget();
  return Object.assign(target, {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    tabIndex: -1,
    focus: () => undefined,
    getContext: () => ({ putImageData: () => undefined }),
  });
}

const roms = () => ({
  kernal: filled(8192, 0xea),
  basic: filled(8192, 0),
  chargen: filled(4096, 0),
});

afterEach(() => vi.unstubAllGlobals());

function stubDom() {
  const documentTarget = new FakeTarget();
  const windowTarget = new FakeTarget();
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  return { documentTarget, windowTarget };
}

describe('start()', () => {
  it('sizes the canvas and listens on the canvas (including blur) by default', async () => {
    const { documentTarget, windowTarget } = stubDom();
    const canvas = fakeCanvas();
    const player = await start({
      canvas: canvas as unknown as HTMLCanvasElement,
      roms: roms(),
      scale: 2,
    });
    expect(canvas.width).toBe(384);
    expect(canvas.height).toBe(272);
    expect(canvas.style['width']).toBe('768px');
    expect(canvas.has('keydown') && canvas.has('keyup') && canvas.has('blur')).toBe(true);
    expect(documentTarget.has('keydown')).toBe(false);
    expect(windowTarget.has('blur')).toBe(false);
    player.destroy();
    expect(canvas.has('keydown')).toBe(false);
  });

  it("with keyboardTarget 'document' key events come from the document and blur from the window", async () => {
    const { documentTarget, windowTarget } = stubDom();
    const canvas = fakeCanvas();
    await start({
      canvas: canvas as unknown as HTMLCanvasElement,
      roms: roms(),
      keyboardTarget: 'document',
    });
    expect(documentTarget.has('keydown') && documentTarget.has('keyup')).toBe(true);
    expect(windowTarget.has('blur')).toBe(true);
    expect(canvas.has('keydown')).toBe(false);
  });
});
