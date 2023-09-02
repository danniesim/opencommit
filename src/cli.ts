#!/usr/bin/env node

import { cli } from 'cleye';
import packageJSON from '../package.json' assert { type: 'json' };

import { configCommand } from './commands/config';
import { hookCommand } from './commands/githook.js';
import { prepareCommitMessageHook } from './commands/prepare-commit-msg-hook';
import { checkIsLatestVersion } from './utils/checkIsLatestVersion';

const extraArgs = process.argv.slice(2);

cli(
  {
    version: packageJSON.version,
    name: 'auto-commit-message',
    commands: [configCommand, hookCommand],
    flags: {},
    ignoreArgv: (type) => type === 'unknown-flag' || type === 'argument',
    help: { description: packageJSON.description }
  },
  async () => {
    checkIsLatestVersion();
    prepareCommitMessageHook();
  },
  extraArgs
);
