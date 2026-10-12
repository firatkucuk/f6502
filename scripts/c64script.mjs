#!/usr/bin/env node

import { formatResult, main, wantsJson } from './lib/c64script-cli.mjs';

const argv = process.argv.slice(2);
const outcome = await main(argv);
const output = formatResult(outcome.result, wantsJson(argv));

if (outcome.exitCode === 0 || wantsJson(argv)) process.stdout.write(output);
else process.stderr.write(output);
process.exitCode = outcome.exitCode;
