import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_FRAMES = 10_000;

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!['new', 'check', 'build', 'run', 'test'].includes(command)) {
    throw new Error(`unknown command '${command ?? ''}'; expected new, check, build, run, or test`);
  }

  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') {
      if (options.json) throw new Error('option --json was provided more than once');
      options.json = true;
    } else if (['--out', '--frames', '--scenario', '--template'].includes(arg)) {
      if (Object.hasOwn(options, arg)) throw new Error(`option ${arg} was provided more than once`);
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`option ${arg} requires a value`);
      options[arg] = value;
      index++;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option '${arg}'`);
    } else {
      positional.push(arg);
    }
  }

  const expectedPositionals = command === 'new' ? 1 : 1;
  if (positional.length !== expectedPositionals) {
    throw new Error(`command '${command}' requires exactly one path argument`);
  }
  const requiredOption = { build: '--out', test: '--scenario', new: '--template' }[command];
  if (requiredOption && !options[requiredOption])
    throw new Error(`command '${command}' requires ${requiredOption}`);
  for (const option of Object.keys(options)) {
    const allowed = {
      new: ['json', '--template'],
      check: ['json'],
      build: ['json', '--out'],
      run: ['json', '--frames'],
      test: ['json', '--scenario'],
    }[command];
    if (!allowed.includes(option))
      throw new Error(`option ${option} is not valid for '${command}'`);
  }

  let frames = 60;
  if (command === 'run' && options['--frames'] !== undefined) {
    frames = Number(options['--frames']);
    if (!Number.isSafeInteger(frames) || frames < 1 || frames > MAX_FRAMES) {
      throw new Error(`--frames must be a positive safe integer no greater than ${MAX_FRAMES}`);
    }
  }

  return { command, path: positional[0], options, frames };
}

async function loadApi(apiPath) {
  if (!existsSync(apiPath)) {
    throw new Error(
      `C64Script build output is missing. Run 'npm run build' from the repository root, then retry.`,
    );
  }
  return import(pathToFileURL(apiPath).href);
}

function errorPayload(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    line: Number.isInteger(error?.line) && error.line > 0 ? error.line : null,
    col: Number.isInteger(error?.col) && error.col >= 0 ? error.col : null,
  };
}

function success(command, result) {
  return { exitCode: 0, result: { ok: true, command, result } };
}

function failure(error, command) {
  return {
    exitCode: 1,
    result: { ok: false, command: command ?? null, error: errorPayload(error) },
  };
}

async function execute(parsed, io) {
  const { command, options } = parsed;
  const cwd = resolve(io.cwd ?? process.cwd());
  const sourcePath = resolve(cwd, parsed.path);

  if (command === 'new') {
    if (options['--template'] !== 'sprite')
      throw new Error(`unknown template '${options['--template']}'`);
    const templateDir = resolve(io.templateDir ?? join(ROOT, 'templates/c64script'));
    const targetDir = sourcePath;
    const sourceTarget = join(targetDir, 'game.c64s');
    const scenarioTarget = join(targetDir, 'game.scenario.json');
    if (existsSync(sourceTarget) || existsSync(scenarioTarget)) {
      throw new Error(`refusing to overwrite files in '${targetDir}'`);
    }

    const templateSource = readFileSync(join(templateDir, 'sprite-game.c64s'));
    const templateScenario = readFileSync(join(templateDir, 'sprite-game.scenario.json'));
    mkdirSync(targetDir, { recursive: true });
    const created = [];
    try {
      writeFileSync(sourceTarget, templateSource, { flag: 'wx' });
      created.push(sourceTarget);
      writeFileSync(scenarioTarget, templateScenario, { flag: 'wx' });
      created.push(scenarioTarget);
    } catch (error) {
      for (const path of created) unlinkSync(path);
      throw error;
    }
    return success(command, { files: [sourceTarget, scenarioTarget] });
  }

  const apiPath = resolve(io.apiPath ?? join(ROOT, 'dist/index.js'));
  const api = await loadApi(apiPath);
  const source = readFileSync(sourcePath, 'utf8');

  if (command === 'check' || command === 'build') {
    const prg = api.compile(source);
    const loadAddress = prg[0] | (prg[1] << 8);
    if (command === 'build') {
      const outputPath = resolve(cwd, options['--out']);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, prg);
      return success(command, { outputPath, loadAddress, bytes: prg.length - 2 });
    }
    return success(command, { loadAddress, bytes: prg.length - 2 });
  }

  const { createGameRunner } = await import('./c64script-runner.mjs');
  const runner = createGameRunner({ maxFrames: MAX_FRAMES + 601 });
  runner.boot(source);

  if (command === 'run') {
    runner.advance(parsed.frames);
    return success(command, { screen: runner.screenText(), framesRun: runner.framesRun });
  }

  const { runScenario } = await import('./c64script-scenarios.mjs');
  const scenarioPath = resolve(cwd, options['--scenario']);
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  return success(command, runScenario(runner, scenario));
}

export async function main(argv, io = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    return await execute(parsed, io);
  } catch (error) {
    return failure(error, parsed?.command);
  }
}

export function formatResult(result, json = false) {
  if (json) return `${JSON.stringify(result)}\n`;
  if (!result.ok) return `${result.error.message}\n`;
  if (result.command === 'check') {
    return `Compiled ${result.result.bytes} bytes; loads at $${result.result.loadAddress.toString(16).padStart(4, '0')}\n`;
  }
  if (result.command === 'build') return `Wrote ${result.result.outputPath}\n`;
  if (result.command === 'new') return `Created ${result.result.files.join(' and ')}\n`;
  if (result.command === 'test') {
    return `Scenario passed: ${result.result.assertions} assertions in ${result.result.framesRun} frames\n`;
  }
  return `${result.result.screen.join('\n')}\n\nRan ${result.result.framesRun} frames\n`;
}

export function wantsJson(argv) {
  return argv.includes('--json');
}
