/**
 * Guards for values that get interpolated into tmux command strings.
 *
 * Two different transports build tmux commands as text, and both are
 * line-oriented:
 *
 *   - `TmuxControl.command()` writes `<command>\n` to the stdin of
 *     `tmux -C attach-session`. Control mode reads *one command per line*.
 *   - `tmuxSessionExists()` shells out via `execSync` with an interpolated
 *     string.
 *
 * Single-quoting an argument is not sufficient for the first transport: a
 * newline inside the quotes still terminates the control-mode command, and
 * everything after it is parsed as a *new tmux command*. Since tmux offers
 * `run-shell`, an attacker-supplied pane id containing `\n` is arbitrary code
 * execution as the user running psyche — and pane ids arrive over the bridge
 * WebSocket from paired devices.
 *
 * So there are two layers here:
 *
 *   1. `assertTmuxPaneId` — pane ids must look like a tmux pane id (`%3`).
 *      Everything psyche stores comes from `#{pane_id}`, so this is exact,
 *      not a heuristic.
 *   2. `quoteTmuxArgument` — refuses control characters outright before
 *      quoting, so any *other* interpolated value (session names derived from
 *      directory names, for instance) cannot break the line either.
 */

/** `#{pane_id}` format: `%` followed by digits. */
const TMUX_PANE_ID_PATTERN = /^%\d{1,19}$/;

/** Anything that could break a line-oriented protocol or a terminal. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

export function isTmuxPaneId(value: unknown): value is string {
  return typeof value === 'string' && TMUX_PANE_ID_PATTERN.test(value);
}

/**
 * Return `value` if it is a tmux pane id, otherwise throw.
 *
 * Callers on the network path should catch this and turn it into a protocol
 * error frame rather than letting it escape.
 */
export function assertTmuxPaneId(value: unknown, label = 'pane id'): string {
  if (!isTmuxPaneId(value)) {
    throw new Error(`invalid ${label}: expected a tmux pane id such as %3`);
  }
  return value;
}

/**
 * Single-quote a value for a tmux command line, rejecting control characters.
 *
 * The rejection is the security-relevant half. Quoting alone protects the
 * *argument boundary*; only the rejection protects the *command boundary*.
 */
export function quoteTmuxArgument(value: string, label = 'tmux argument'): string {
  if (typeof value !== 'string') {
    throw new Error(`invalid ${label}: expected a string`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(`invalid ${label}: control characters are not allowed`);
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Reject a fully-assembled tmux control-mode command that spans lines.
 *
 * Last line of defence: if some future call site interpolates a value without
 * going through `quoteTmuxArgument`, this still stops the command boundary
 * from being crossed.
 */
export function assertSingleTmuxCommandLine(line: string): string {
  if (/[\r\n]/.test(line)) {
    throw new Error('invalid tmux command: must be a single line');
  }
  return line;
}
