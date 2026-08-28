#!/usr/bin/env node

import { runBeadsProjectCli } from './beads-project-sync/cli.mjs';

process.exitCode = await runBeadsProjectCli(process.argv.slice(2));
