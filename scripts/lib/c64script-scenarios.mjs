import { KEY_POSITION } from '../../dist/index.js';

function fail(path, message) {
  throw new TypeError(`${path}: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, path) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(path, `expected exactly these fields: ${keys.join(', ')}`);
  }
}

function positiveSafeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(path, 'must be a positive safe integer');
  }
}

function normalizeStep(step, index) {
  const path = `scenario.steps[${index}]`;
  if (!isRecord(step) || Object.keys(step).length !== 1) {
    fail(path, 'must contain exactly one action');
  }

  if (Object.hasOwn(step, 'frames')) {
    positiveSafeInteger(step.frames, `${path}.frames`);
    return { frames: step.frames };
  }
  if (Object.hasOwn(step, 'keyDown') || Object.hasOwn(step, 'keyUp')) {
    const action = Object.hasOwn(step, 'keyDown') ? 'keyDown' : 'keyUp';
    const key = step[action];
    if (typeof key !== 'string' || !Object.hasOwn(KEY_POSITION, key)) {
      fail(`${path}.${action}`, `unsupported C64 key '${String(key)}'`);
    }
    return { [action]: key };
  }
  if (Object.hasOwn(step, 'waitForText')) {
    const value = step.waitForText;
    if (!isRecord(value)) fail(`${path}.waitForText`, 'must be an object');
    exactKeys(value, ['contains', 'maxFrames'], `${path}.waitForText`);
    if (typeof value.contains !== 'string' || value.contains.length === 0) {
      fail(`${path}.waitForText.contains`, 'must be a nonempty string');
    }
    positiveSafeInteger(value.maxFrames, `${path}.waitForText.maxFrames`);
    return { waitForText: { contains: value.contains, maxFrames: value.maxFrames } };
  }
  if (Object.hasOwn(step, 'assertText')) {
    const value = step.assertText;
    if (!isRecord(value)) fail(`${path}.assertText`, 'must be an object');
    exactKeys(value, ['contains'], `${path}.assertText`);
    if (typeof value.contains !== 'string' || value.contains.length === 0) {
      fail(`${path}.assertText.contains`, 'must be a nonempty string');
    }
    return { assertText: { contains: value.contains } };
  }
  if (Object.hasOwn(step, 'assertMemory')) {
    const value = step.assertMemory;
    if (!isRecord(value)) fail(`${path}.assertMemory`, 'must be an object');
    exactKeys(value, ['address', 'equals'], `${path}.assertMemory`);
    if (!Number.isSafeInteger(value.address) || value.address < 0 || value.address > 0xffff) {
      fail(`${path}.assertMemory.address`, 'must be an integer from 0 through 65535');
    }
    if (!Number.isSafeInteger(value.equals) || value.equals < 0 || value.equals > 0xff) {
      fail(`${path}.assertMemory.equals`, 'must be an integer from 0 through 255');
    }
    return { assertMemory: { address: value.address, equals: value.equals } };
  }

  fail(path, `unknown action '${Object.keys(step)[0] ?? ''}'`);
}

export function validateScenario(value) {
  if (!isRecord(value)) fail('scenario', 'must be an object');
  exactKeys(value, ['version', 'maxFrames', 'steps'], 'scenario');
  if (value.version !== 1) fail('scenario.version', 'only version 1 is supported');
  positiveSafeInteger(value.maxFrames, 'scenario.maxFrames');
  if (!Array.isArray(value.steps)) fail('scenario.steps', 'must be an array');

  return {
    version: 1,
    maxFrames: value.maxFrames,
    steps: value.steps.map(normalizeStep),
  };
}

export function runScenario(runner, value) {
  const scenario = validateScenario(value);
  let scenarioFrames = 0;
  let assertions = 0;

  function checkBudget(frames) {
    if (scenarioFrames + frames > scenario.maxFrames) {
      throw new Error(`frame budget of ${scenario.maxFrames} would be exceeded`);
    }
  }

  for (let index = 0; index < scenario.steps.length; index++) {
    const step = scenario.steps[index];
    const path = `scenario step ${index}`;
    try {
      if (Object.hasOwn(step, 'frames')) {
        checkBudget(step.frames);
        runner.advance(step.frames);
        scenarioFrames += step.frames;
      } else if (Object.hasOwn(step, 'waitForText')) {
        const { contains, maxFrames } = step.waitForText;
        let found = runner.screenText().join('\n').includes(contains);
        for (let frame = 0; !found && frame < maxFrames; frame++) {
          checkBudget(1);
          runner.advance(1);
          scenarioFrames++;
          found = runner.screenText().join('\n').includes(contains);
        }
        if (!found) throw new Error(`did not find '${contains}' within ${maxFrames} frames`);
        assertions++;
      } else if (Object.hasOwn(step, 'keyDown')) {
        runner.keyDown(step.keyDown);
      } else if (Object.hasOwn(step, 'keyUp')) {
        runner.keyUp(step.keyUp);
      } else if (Object.hasOwn(step, 'assertText')) {
        const { contains } = step.assertText;
        if (!runner.screenText().join('\n').includes(contains)) {
          throw new Error(`screen text did not contain '${contains}'`);
        }
        assertions++;
      } else if (Object.hasOwn(step, 'assertMemory')) {
        const { address, equals } = step.assertMemory;
        const actual = runner.peek(address);
        if (actual !== equals) {
          throw new Error(
            `memory at $${address.toString(16).padStart(4, '0')} was ${actual}, expected ${equals}`,
          );
        }
        assertions++;
      }
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  return { passed: true, framesRun: scenarioFrames, assertions };
}
