#!/usr/bin/env node

import './cli/env.js';
import { createProgram } from './cli/program.js';

const program = createProgram();
program.parse();

// Show help if no command
if (!process.argv.slice(2).length) {
  program.help();
}
