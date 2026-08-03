import { spawn, type ChildProcessWithoutNullStreams, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  assertSingleTmuxCommandLine,
  assertTmuxPaneId,
  quoteTmuxArgument,
} from '../../utils/tmuxTarget.js';

/**
 * Thin wrapper around `tmux -C attach-session` (tmux control mode).
 *
 * One subprocess per tmux session. Parses `%output`, `%exit`, and
 * `%window-close` events. Commands are written to stdin as plain tmux
 * commands terminated with \n; responses come back as %begin/%end blocks
 * but we don't use them yet — most ops are fire-and-forget for now.
 *
 * Lifted from meow/psyche-daemon-ws commit cda47c5 into src/services/bridge/
 * per docs/superpowers/plans/2026-04-25-psyche-bridge-daemon.md.
 */
export class TmuxControl extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = '';
  private started = false;

  constructor(public readonly sessionName: string) {
    super();
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.proc = spawn('tmux', ['-C', 'attach-session', '-t', this.sessionName], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString('utf8'));
    });

    this.proc.on('exit', (code) => {
      this.emit('exit', code);
      this.proc = null;
      this.started = false;
    });
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
  }

  sendKeysHex(paneId: string, data: Buffer): void {
    const target = assertTmuxPaneId(paneId);
    if (data.length === 0) return;
    const hex = Array.from(data, (b) => b.toString(16).padStart(2, '0')).join(' ');
    this.command(`send-keys -t ${quote(target)} -H ${hex}`);
  }

  resizePane(paneId: string, cols: unknown, rows: unknown): void {
    const target = assertTmuxPaneId(paneId);
    const x = tmuxDimensionArg(cols, 'cols');
    const y = tmuxDimensionArg(rows, 'rows');
    this.command(`resize-pane -t ${quote(target)} -x ${x} -y ${y}`);
  }

  killPane(paneId: string): void {
    this.command(`kill-pane -t ${quote(assertTmuxPaneId(paneId))}`);
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
    if (!line.startsWith('%')) return;

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
      this.emit('tmuxExit', line);
      return;
    }

    if (line.startsWith('%window-close') || line.startsWith('%unlinked-window-close')) {
      this.emit('windowClose', line);
      return;
    }
    // %begin/%end/%error blocks ignored for now
  }
}

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
