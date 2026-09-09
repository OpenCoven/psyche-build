import path from 'node:path';
import { LogService, type LogEntry } from '../services/LogService.js';
import { WorktreeCleanupService } from '../services/WorktreeCleanupService.js';
import { projectPaneConfigPath } from '../services/ProjectPaneConfig.js';

// This entry point is forked only inside the disposable recovery harness.
const deadline = setTimeout(() => process.exit(2), 20_000);
const logger = LogService.getInstance();
logger.setSuppressConsole(true);

process.once('message', (request: unknown) => {
  if (
    !request || typeof request !== 'object'
    || !('projectRoot' in request) || typeof request.projectRoot !== 'string'
    || !('branch' in request) || !['retained', 'control'].includes(String(request.branch))
  ) {
    process.exit(2);
  }
  const projectRoot = request.projectRoot;
  const branch = String(request.branch);
  let markerBlocked = false;
  logger.on('log-added', (entry: LogEntry) => {
    if (entry.source !== 'paneActions' || entry.paneId !== 'harness-cleanup') return;
    if (entry.level === 'warn' && entry.message.includes('requires operator acknowledgement')) {
      markerBlocked = true;
    }
    if (entry.level === 'error') process.exit(2);
    if (entry.message === `Finished background worktree cleanup for ${branch}`) {
      clearTimeout(deadline);
      process.send?.({ type: 'finished', markerBlocked }, () => process.exit(0));
    }
  });
  new WorktreeCleanupService().enqueueCleanup({
    pane: {
      id: 'harness-cleanup',
      paneId: '%1',
      slug: branch,
      branchName: branch,
      prompt: '',
      worktreePath: path.join(projectRoot, '.psyche', 'worktrees', branch),
    },
    paneProjectRoot: projectRoot,
    mainRepoPath: projectRoot,
    configPath: projectPaneConfigPath(projectRoot),
    currentProjectRoot: projectRoot,
    deleteBranch: true,
  });
});
