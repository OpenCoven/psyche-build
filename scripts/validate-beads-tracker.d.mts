interface TrackerDriftConfigIdentity {
  owner: string;
  repository: string;
}

interface TrackerDriftWritable {
  write(value: string): unknown;
}

interface TrackerDriftRunDependencies {
  cwd?: string;
  stdout?: TrackerDriftWritable;
  stderr?: TrackerDriftWritable;
  configPath?: string;
  rawIssues?: readonly unknown[];
  fetchImpl?: typeof fetch;
}

export function loadPublicGitHubIssues(
  config: TrackerDriftConfigIdentity,
  fetchImpl?: typeof fetch,
  options?: { maxPages?: number },
): Promise<unknown[]>;

export function runTrackerDriftCheck(
  argv: readonly string[],
  suppliedDependencies?: TrackerDriftRunDependencies,
): Promise<number>;
