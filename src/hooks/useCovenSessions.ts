import { useEffect, useMemo, useState } from 'react';
import type { SidebarProject } from '../types.js';
import {
  filterCovenSessionsForProjectRoots,
  listCovenSessionsFromDaemon,
  listCovenSessionsFromCli,
  type CovenSessionsLoadState,
} from '../utils/covenSessions.js';

export interface UseCovenSessionsOptions {
  enabled?: boolean;
  refreshMs?: number;
  command?: string;
  includeUnscoped?: boolean;
}

const INITIAL_COVEN_STATE: CovenSessionsLoadState = {
  status: 'empty',
  sessions: [],
  source: 'coven sessions --json',
  loadedAt: '',
};

export function useCovenSessions(
  sessionProjectRoot: string,
  sidebarProjects: SidebarProject[],
  options: UseCovenSessionsOptions = {},
): CovenSessionsLoadState {
  const enabled = options.enabled ?? !isVitest();
  const refreshMs = options.refreshMs ?? 15_000;
  const includeUnscoped = options.includeUnscoped ?? false;
  const [state, setState] = useState<CovenSessionsLoadState>(INITIAL_COVEN_STATE);

  const projectRoots = useMemo(() => {
    const roots = [sessionProjectRoot];
    for (const project of sidebarProjects) {
      roots.push(project.projectRoot);
    }
    return Array.from(new Set(roots.filter(Boolean)));
  }, [sessionProjectRoot, sidebarProjects]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const load = async () => {
      const result = options.command
        ? await listCovenSessionsFromCli({ command: options.command })
        : await listCovenSessionsFromDaemon();
      if (cancelled) return;

      const selectedState = await selectCovenSessionsLoadState(
        result,
        projectRoots,
        { includeUnscoped },
      );
      if (cancelled) return;

      setState(selectedState);
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, refreshMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, includeUnscoped, options.command, projectRoots, refreshMs]);

  return state;
}

export async function selectCovenSessionsLoadState(
  result: CovenSessionsLoadState,
  projectRoots: string[],
  options: Pick<UseCovenSessionsOptions, 'includeUnscoped'> = {},
): Promise<CovenSessionsLoadState> {
  if (result.status !== 'ready') return result;

  const sessions = options.includeUnscoped
    ? result.sessions
    : await filterCovenSessionsForProjectRoots(result.sessions, projectRoots);

  return sessions.length > 0
    ? { ...result, sessions }
    : {
        status: 'empty',
        sessions: [],
        source: result.source,
        loadedAt: result.loadedAt,
      };
}

function isVitest(): boolean {
  return typeof process !== 'undefined' && !!process.env.VITEST_WORKER_ID;
}

export default useCovenSessions;
