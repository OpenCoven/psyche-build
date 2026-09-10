#!/usr/bin/env node

import { runReconcileDuplicatesCli } from './beads-project-sync/reconcile-duplicates-cli.mjs';

process.exitCode = await runReconcileDuplicatesCli(process.argv.slice(2));
