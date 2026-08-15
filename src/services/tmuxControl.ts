import { spawn, type ChildProcessWithoutNullStreams, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validatePaneNamedKeys } from '../control/types.js';
import {
  assertSingleTmuxCommandLine,
  assertTmuxPaneId,
  quoteTmuxArgument,
} from '../utils/tmuxTarget.js';
import { AGENT_CONTROL_LIMITS } from '../control/limits.js';

/**
 * Thin wrapper around `tmux -C attach-session` (tmux control mode).
 *
 * One subprocess per tmux session. Parses `%output`, `%exit`, and
 * `%window-close` events. Legacy UI ops (`command`, `resizePane`, ...) remain
 * fire-and-forget. Effectful agent-facing seams (`sendKeysHex`, `killPane`,
 * `executeCommand`, and `sendPrompt`) correlate the `%begin/%end/%error`
 * acknowledgement block so dispatch is integrity-checked and safe against
 * replay on an ambiguous drop.
 *
 * Originally lifted from meow/psyche-daemon-ws commit cda47c5 per
 * docs/superpowers/plans/2026-04-25-psyche-bridge-daemon.md, then copied a
 * second time into src/daemon/. Shared here because the two copies drifted:
 * only this one learned to handle surrogate pairs, so the daemon streamed
 * every astral-plane character (emoji, CJK extensions) to clients as U+FFFD,
 * and only the daemon copy had selectPane. Both transports — the LAN bridge
 * in ./bridge/ and the loopback daemon in ../daemon/ — now use this module.
 */
export interface TmuxControlOptions {
  /**
   * Inject the control subprocess. Tests supply a fake so acknowledged
   * submission can be exercised without a live tmux server.
   */
  spawnControl?: () => ChildProcessWithoutNullStreams;
  actionTimeoutMs?: number;
}

interface AckWaiter {
__OURS__
  reject: (error: Error & { ambiguous?: boolean }) => void;
  readonly lines: string[];
  outputBytes: number;
  outputLines: number;
  outputTooLarge: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class TmuxControl extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = '';
  private started = false;

  /**
   * FIFO of acknowledgement waiters, one entry per command written to the
   * control connection. tmux answers every command with exactly one
   * `%begin ... %end`/`%error` block, in the order the commands were sent, so
   * the front of this queue always corresponds to the next block to arrive.
   * Fire-and-forget commands push `null` (their block is discarded);
   * `executeCommand` pushes a waiter that resolves/rejects on its block.
   *
   * `commandTail` additionally serializes `executeCommand` writes so an
   * acknowledged command is not issued until the previous one has settled.
   */
  private commandTail: Promise<void> = Promise.resolve();
  private readonly ackQueue: Array<AckWaiter | null> = [];
__OURS__

  /**
   * Attaching in control mode emits one unsolicited `%begin/%end` block for the
   * attach itself, before any client command. Consume it so it does not shift a
   * real command off the FIFO.
   */
  private attachAckConsumed = false;
  private paneSetEmptyEmitted = false;
  private processTerminationHandled = false;
  private poisoned = false;

  constructor(
    public readonly sessionName: string,
    private readonly options: TmuxControlOptions = {},
  ) {
    super();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attachAckConsumed = false;
__OURS__

    const proc = this.options.spawnControl
      ? this.options.spawnControl()
      : spawn('tmux', ['-C', 'attach-session', '-t', this.sessionName], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
    this.proc = proc;

__OURS__
    });

    proc.on('exit', (code) => this.onProcessTerminated(proc, code));
    proc.on('close', (code) => this.onProcessTerminated(proc, code));
  }

  private onProcessTerminated(proc: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.proc !== proc) return;
    this.emitPaneSetEmpty();
    if (this.processTerminationHandled) return;
    this.processTerminationHandled = true;
    this.rejectAllPending(
      Object.assign(new Error('tmux command outcome is unknown'), { ambiguous: true }),
    );
    this.emit('exit', code);
    this.proc = null;
    this.started = false;
  }

  private emitPaneSetEmpty(): void {
    if (this.paneSetEmptyEmitted) return;
    this.paneSetEmptyEmitted = true;
    this.emit('paneSetEmpty');
  }

  private rejectAllPending(error: Error & { ambiguous?: boolean }): void {
    const waiters = this.ackQueue.splice(0, this.ackQueue.length);
__MERGED_OURS_PENDING_REJECTION_WITH_TIMER_CLEAR_IF_PRESENT__
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    this.proc.kill('SIGTERM');
  }

  /**
   * Send a raw tmux command over the control connection.
   *
   * Control mode is line-oriented, so a command containing a newline is really
   * two commands. Rejecting that here backstops the per-argument guards below.
   */
  command(line: string): void {
    assertSingleTmuxCommandLine(line);
    if (!this.proc) throw new Error('tmux control mode not started');
    this.proc.stdin.write(line + '\n');
    // Fire-and-forget, but still consumes one acknowledgement block so it stays
    // aligned with the FIFO used by executeCommand().
    this.ackQueue.push(null);
  }

  /**
   * Send a tmux command and resolve only once tmux acknowledges it with its
   * `%end`, reject on `%error`, and reject as *ambiguous* when the control
   * connection drops with the command still outstanding (or the write itself
   * fails). Ambiguous failures must never be auto-retried: tmux may already
   * have applied them.
   */
  executeCommand(line: string): Promise<void> {
__MERGED_OURS_EXECUTE_QUERY_PATH_WITH_COMPAT_EXECUTE_COMMAND_WITH_OUTPUT_ALIAS__
      });
    const result = this.commandTail.then(run, run);
    this.commandTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private poisonConnection(error: Error, proc: ChildProcessWithoutNullStreams): void {
    if (this.poisoned || this.proc !== proc) return;
    this.poisoned = true;
    const ambiguous = Object.assign(error, { ambiguous: true as const });
    this.rejectAllPending(ambiguous);
    this.emitPaneSetEmpty();
    if (!this.processTerminationHandled) {
      this.processTerminationHandled = true;
      this.emit('exit', null);
    }
    this.proc = null;
    this.started = false;
    try { proc?.kill('SIGTERM'); } catch { /* retired */ }
  }

  sendKeysHexAcknowledged(paneId: string, data: Buffer): Promise<void> {
    const target = assertTmuxPaneId(paneId);
    const hex = Array.from(data, (b) => b.toString(16).padStart(2, '0')).join(' ');
    return this.executeCommand(
      hex ? `send-keys -t ${quote(target)} -H ${hex}` : `send-keys -t ${quote(target)} -H`,
    );
  }

  sendNamedKeysAcknowledged(paneId: string, keys: readonly string[]): Promise<void> {
    const target = assertTmuxPaneId(paneId);
    if (keys.length === 0) return Promise.resolve();
    const validated = validatePaneNamedKeys(keys);
    return this.executeCommand(`send-keys -t ${quote(target)} ${validated.join(' ')}`);
  }

  selectPaneAcknowledged(paneId: string): Promise<void> {
    return this.executeCommand(`select-pane -t ${quote(assertTmuxPaneId(paneId))}`);
  }

  resizePaneAcknowledged(paneId: string, cols: unknown, rows: unknown): Promise<void> {
    const target = assertTmuxPaneId(paneId);
    return this.executeCommand(
      `resize-pane -t ${quote(target)} -x ${tmuxDimensionArg(cols, 'cols')} -y ${tmuxDimensionArg(rows, 'rows')}`,
    );
  }

  killPaneAcknowledged(paneId: string): Promise<void> {
    return this.executeCommand(`kill-pane -t ${quote(assertTmuxPaneId(paneId))}`);
  }

  async queryPane(paneId: string): Promise<{
    paneId: string; cols: number; rows: number; focused: boolean;
  }> {
    const target = assertTmuxPaneId(paneId);
    const output = await this.executeQuery(
      `display-message -p -t ${quote(target)} '#{pane_id}\t#{pane_width}\t#{pane_height}\t#{pane_active}'`,
    );
    const [observedId, cols, rows, active] = output.trim().split('\t');
    if (observedId !== target || !/^\d+$/.test(cols ?? '') || !/^\d+$/.test(rows ?? '') || !/^[01]$/.test(active ?? '')) {
      throw new Error('tmux pane query returned malformed state');
    }
    return Object.freeze({
      paneId: observedId,
      cols: Number(cols),
      rows: Number(rows),
      focused: active === '1',
    });
  }

  async listPaneIds(): Promise<readonly string[]> {
    const output = await this.executeQuery("list-panes -s -F '#{pane_id}'");
    const ids = output.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const id of ids) assertTmuxPaneId(id);
    return Object.freeze(ids);
  }

  /**
   * Acknowledged prompt submission: send the UTF-8 body as hex-encoded keys,
   * then optionally Enter, waiting for each to be acknowledged. A disconnect at
   * any point surfaces as an ambiguous rejection so the dispatcher records the
   * outcome as `unknown` rather than replaying the prompt.
   */
  async sendPrompt(
    paneId: string,
    utf8: string,
    submitMode: 'text' | 'text-and-enter',
  ): Promise<void> {
    const target = assertTmuxPaneId(paneId);
    const hex = Array.from(Buffer.from(utf8, 'utf8'), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(' ');
    await this.executeCommand(`send-keys -t ${quote(target)} -H ${hex}`);
    if (submitMode === 'text-and-enter') {
      await this.executeCommand(`send-keys -t ${quote(target)} Enter`);
    }
  }

  sendKeysHex(paneId: string, data: Buffer): void | Promise<void> {
    const target = assertTmuxPaneId(paneId);
    if (data.length === 0) return Promise.resolve();
    return this.executeCommand(`send-keys -t ${quote(target)} -H ${hexBytes(data)}`);
  }

  resizePane(paneId: string, cols: unknown, rows: unknown): void {
    const target = assertTmuxPaneId(paneId);
    const x = tmuxDimensionArg(cols, 'cols');
    const y = tmuxDimensionArg(rows, 'rows');
    this.command(`resize-pane -t ${quote(target)} -x ${x} -y ${y}`);
  }

  selectPane(paneId: string): void {
    this.command(`select-pane -t ${quote(assertTmuxPaneId(paneId))}`);
  }

  killPane(paneId: string): void | Promise<void> {
    const target = assertTmuxPaneId(paneId);
    return this.executeCommand(`kill-pane -t ${quote(target)}`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
__MERGED_OURS_ACK_BLOCK_OUTPUT_COLLECTION_FOR_NON_PERCENT_LINES__
    // %output %<paneId> <octal-escaped-bytes>
    if (line.startsWith('%output ')) {
      const rest = line.slice('%output '.length);
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) return;
      const paneId = rest.slice(0, spaceIdx);
      const escaped = rest.slice(spaceIdx + 1);
      const payload = unescapeTmuxOutput(escaped);
      this.emit('output', paneId, payload);
      return;
    }

    if (line.startsWith('%exit')) {
      this.emitPaneSetEmpty();
      this.emit('tmuxExit', line);
      return;
    }

    if (line.startsWith('%window-close') || line.startsWith('%unlinked-window-close')) {
      this.emit('windowClose', line);
    }

    if (PANE_SET_NOTIFICATIONS.some((prefix) => line.startsWith(prefix))) {
      this.emit('paneSetChanged');
      return;
    }

    // Command acknowledgement blocks: %begin/%end/%error <time> <number> <flags>.
    // Every command produces exactly one block, delivered in send order, so the
    // front of ackQueue is the block being closed. %begin only opens the block.
__OURS__
      if (!waiter) return; // fire-and-forget block (null) or an unexpected extra
      if (waiter.timer) clearTimeout(waiter.timer);
      if (line.startsWith('%error')) {
        waiter.reject(new Error(`tmux command failed: ${line}`));
      } else if (waiter.outputTooLarge) {
        waiter.reject(Object.assign(new Error('tmux command output exceeds limit'), {
          code: 'output_truncated',
        }));
      } else {
__OURS__
      }
      return;
    }
    if (!this.activeIgnoredCommandNumber && this.activeCommandNumber) {
      this.ackBlocks.get(this.activeCommandNumber)?.output.push(line);
    }
  }

  private rememberCompletedAck(commandNumber: string): void {
    this.completedAckNumbers.add(commandNumber);
    while (this.completedAckNumbers.size > 1_024) {
      this.completedAckNumbers.delete(this.completedAckNumbers.values().next().value!);
    }
  }
}

__MERGED_OURS_PARSE_ACK_AND_PANE_NOTIFICATION_CONSTANTS_PLUS_THEIRS_OUTPUT_LIMIT_CONSTS__
/**
 * Tmux control-mode encodes output bytes in the range \x00-\x1f and \x7f-\xff
 * as \ooo (backslash + 3 octal digits). A literal backslash becomes \\.
 * Everything else passes through as UTF-8.
 */
export function unescapeTmuxOutput(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x5c /* \ */ && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next === 0x5c) {
        out.push(0x5c);
        i += 1;
        continue;
      }
      if (next >= 0x30 && next <= 0x37 && i + 3 < s.length) {
        const oct = s.slice(i + 1, i + 4);
        if (/^[0-3][0-7][0-7]$/.test(oct)) {
          out.push(parseInt(oct, 8));
          i += 3;
          continue;
        }
      }
    }
    if (ch < 0x80) {
      out.push(ch);
    } else {
      const char = String.fromCodePoint(s.codePointAt(i)!);
      const bytes = Buffer.from(char, 'utf8');
      for (const b of bytes) out.push(b);
      if (char.length > 1) i += char.length - 1;
    }
  }
  return Buffer.from(out);
}

function quote(s: string): string {
  return quoteTmuxArgument(s);
}

const TMUX_DIMENSION_MAX = 65535;

export function tmuxDimensionArg(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }

  const n = Math.trunc(value);
  if (n < 1 || n > TMUX_DIMENSION_MAX) {
    throw new Error(`${label} out of range (1-${TMUX_DIMENSION_MAX})`);
  }

  return n;
}

/**
 * Mirrors `Psyche.buildSessionNameForRoot` in src/index.ts so the daemon
 * derives the same session name psyche itself uses.
 */
export function tmuxSessionNameForRoot(projectRoot: string): string {
  const projectName = path.basename(projectRoot);
  const projectHash = createHash('md5').update(projectRoot).digest('hex').substring(0, 8);
  const ident = `${projectName}-${projectHash}`.replace(/\./g, '-');
  return `psyche-${ident}`;
}

export function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${quote(name)}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
