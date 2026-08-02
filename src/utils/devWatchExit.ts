const DEV_WATCH_TERMINATION_SIGNALS = new Set<NodeJS.Signals>([
  'SIGINT',
  'SIGTERM',
]);

export function shouldUseQuietDevWatchExit(signal?: NodeJS.Signals): boolean {
  return (
    process.env.PSYCHE_DEV_WATCH === 'true' &&
    signal !== undefined &&
    DEV_WATCH_TERMINATION_SIGNALS.has(signal)
  );
}
