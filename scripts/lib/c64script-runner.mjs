import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { C64, KEY_POSITION, compile } from '../../dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_MAX_FRAMES = 1200;
const DEFAULT_READY_TIMEOUT_FRAMES = 600;

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function readRoms() {
  return {
    kernal: new Uint8Array(readFileSync(resolve(ROOT, 'website/demos/kernal.bin'))),
    basic: new Uint8Array(readFileSync(resolve(ROOT, 'website/demos/basic.bin'))),
    chargen: new Uint8Array(readFileSync(resolve(ROOT, 'website/demos/chargen.bin'))),
  };
}

export function createGameRunner({
  maxFrames = DEFAULT_MAX_FRAMES,
  readyTimeoutFrames = DEFAULT_READY_TIMEOUT_FRAMES,
  roms,
} = {}) {
  positiveSafeInteger(maxFrames, 'maxFrames');
  positiveSafeInteger(readyTimeoutFrames, 'readyTimeoutFrames');

  let machine = null;
  let framesRun = 0;
  let booted = false;

  function requireMachine() {
    if (!machine) throw new Error('game runner has not booted a program yet');
    return machine;
  }

  function runOneFrame() {
    if (framesRun >= maxFrames) {
      throw new Error(`total frame limit of ${maxFrames} exceeded`);
    }
    requireMachine().runFrame();
    framesRun++;
  }

  function advance(frames) {
    positiveSafeInteger(frames, 'frames');
    if (framesRun + frames > maxFrames) {
      throw new Error(`advancing ${frames} frames would exceed total frame limit of ${maxFrames}`);
    }
    for (let i = 0; i < frames; i++) runOneFrame();
  }

  function validateKey(key) {
    if (typeof key !== 'string' || !Object.hasOwn(KEY_POSITION, key)) {
      throw new Error(`unsupported C64 key '${String(key)}'`);
    }
  }

  function boot(source) {
    if (booted) throw new Error('game runner can only boot one program');
    const prg = compile(source);
    const loadAddress = prg[0] | (prg[1] << 8);
    if (loadAddress !== 0x0810) {
      throw new Error(
        `program load address must be $0810, got $${loadAddress.toString(16).padStart(4, '0')}`,
      );
    }

    machine = new C64(roms ?? readRoms());
    for (let i = 0; i < readyTimeoutFrames && !machine.isReady(); i++) {
      if (framesRun >= maxFrames) {
        throw new Error(`total frame limit of ${maxFrames} exceeded before READY`);
      }
      machine.runFrame();
      framesRun++;
    }
    if (!machine.isReady()) {
      throw new Error(`KERNAL did not display READY within ${readyTimeoutFrames} frames`);
    }

    machine.loadPrg(prg);
    runOneFrame();
    booted = true;
    return machine;
  }

  return {
    get c64() {
      return requireMachine();
    },
    boot,
    advance,
    keyDown(key) {
      validateKey(key);
      requireMachine().keyDown(key);
    },
    keyUp(key) {
      validateKey(key);
      requireMachine().keyUp(key);
    },
    screenText() {
      return requireMachine().screenText();
    },
    peek(address) {
      if (!Number.isSafeInteger(address) || address < 0 || address > 0xffff) {
        throw new RangeError('address must be an integer from 0 through 65535');
      }
      return requireMachine().peek(address);
    },
    get framesRun() {
      return framesRun;
    },
  };
}
