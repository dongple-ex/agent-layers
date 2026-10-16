#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = typeof code === 'number' ? code : 0;
  })
  .catch((err) => {
    process.stderr.write(`agent-layers: ${err && err.message ? err.message : err}\n`);
    if (process.env.AGENT_LAYERS_DEBUG) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = 1;
  });
