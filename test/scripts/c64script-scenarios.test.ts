import { describe, expect, it } from 'vitest';
import { runScenario, validateScenario } from '../../scripts/lib/c64script-scenarios.mjs';

const scenario = (steps: unknown[], maxFrames = 10) => ({ version: 1, maxFrames, steps });

function fakeRunner({ screen = '', memory = 0, titleAtFrame = 2 } = {}) {
  const held = new Set<string>();
  let framesRun = 0;
  let currentScreen = screen;
  return {
    held,
    get framesRun() {
      return framesRun;
    },
    advance(frames: number) {
      framesRun += frames;
      if (titleAtFrame !== null && framesRun >= titleAtFrame) currentScreen = 'TITLE  SCORE 1';
    },
    keyDown(key: string) {
      held.add(key);
    },
    keyUp(key: string) {
      held.delete(key);
    },
    screenText() {
      return [currentScreen];
    },
    peek(address: number) {
      return address === 0x0900 ? memory : 0;
    },
  };
}

describe('C64Script scenario validation', () => {
  it('rejects a version it does not understand', () => {
    expect(() => validateScenario({ version: 2, maxFrames: 10, steps: [] })).toThrow(/version/);
  });

  it('requires a positive safe frame budget', () => {
    expect(() => validateScenario(scenario([], 0))).toThrow(/maxFrames/);
    expect(() => validateScenario(scenario([], Number.MAX_SAFE_INTEGER + 1))).toThrow(/maxFrames/);
  });

  it('rejects missing steps and unknown action keys', () => {
    expect(() => validateScenario({ version: 1, maxFrames: 10 })).toThrow(/steps/);
    expect(() => validateScenario(scenario([{ wait: 3 }]))).toThrow(/steps\[0\]/);
  });

  it('rejects unsupported keys and invalid memory assertions before execution', () => {
    expect(() => validateScenario(scenario([{ keyDown: 'ESC' }]))).toThrow(/unsupported C64 key/);
    expect(() =>
      validateScenario(scenario([{ assertMemory: { address: 0x10000, equals: 0 } }])),
    ).toThrow(/address/);
    expect(() =>
      validateScenario(scenario([{ assertMemory: { address: 0x0900, equals: 256 } }])),
    ).toThrow(/equals/);
  });

  it('rejects actions with extra or malformed fields', () => {
    expect(() => validateScenario(scenario([{ frames: 1, keyDown: 'A' }]))).toThrow(
      /exactly one action/,
    );
    expect(() => validateScenario(scenario([{ frames: -1 }]))).toThrow(/positive safe integer/);
    expect(() =>
      validateScenario(scenario([{ waitForText: { contains: '', maxFrames: 3 } }])),
    ).toThrow(/contains/);
  });
});

describe('C64Script scenario execution', () => {
  it('waits for text, checks memory, and preserves held keys until release', () => {
    const runner = fakeRunner({ memory: 7 });
    const result = runScenario(
      runner,
      validateScenario(
        scenario([
          { waitForText: { contains: 'TITLE', maxFrames: 3 } },
          { keyDown: 'A' },
          { frames: 1 },
          { assertText: { contains: 'SCORE 1' } },
          { assertMemory: { address: 0x0900, equals: 7 } },
          { keyUp: 'A' },
        ]),
      ),
    );

    expect(result).toEqual({ passed: true, framesRun: 3, assertions: 3 });
    expect(runner.held.has('A')).toBe(false);
  });

  it('fails a text wait at its step when the text never appears', () => {
    const runner = fakeRunner({ screen: 'BOOTING', titleAtFrame: null });

    expect(() =>
      runScenario(
        runner,
        validateScenario(scenario([{ waitForText: { contains: 'TITLE', maxFrames: 2 } }], 5)),
      ),
    ).toThrow(/step 0.*TITLE.*2 frames/i);
    expect(runner.framesRun).toBe(2);
  });

  it('fails a text or memory assertion at the action that failed', () => {
    const runner = fakeRunner();

    expect(() =>
      runScenario(runner, validateScenario(scenario([{ assertText: { contains: 'MISSING' } }]))),
    ).toThrow(/step 0.*MISSING/i);
    expect(() =>
      runScenario(
        runner,
        validateScenario(scenario([{ assertMemory: { address: 0x0900, equals: 1 } }])),
      ),
    ).toThrow(/step 0.*\$0900/i);
  });

  it('enforces the scenario frame budget before advancing past it', () => {
    const runner = fakeRunner();

    expect(() =>
      runScenario(runner, validateScenario(scenario([{ frames: 2 }, { frames: 2 }], 3))),
    ).toThrow(/step 1.*frame budget of 3/i);
    expect(runner.framesRun).toBe(2);
  });
});
