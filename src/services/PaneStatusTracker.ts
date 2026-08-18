import path from 'path';
import type { AgentName } from '../utils/agentLaunch.js';
import {
  buildPaneActivityFingerprint,
  hasAgentWorkingIndicators,
  isLikelyUserTyping,
} from '../utils/paneAttentionHeuristics.js';
import type {
  AnalysisNeededPayload,
  CodexTurnStoppedPayload,
  StatusChangePayload,
  UserInteractionPayload,
} from '../workers/WorkerMessages.js';

export type PaneStatus = 'idle' | 'analyzing' | 'waiting' | 'working';

/**
 * What a tick decided. These map one-to-one onto the worker message types the
 * status pipeline already speaks, so whatever drives the tracker can forward
 * them without translation.
 */
export type PaneStatusEvent =
  | { type: 'status-change'; payload: StatusChangePayload }
  | { type: 'analysis-needed'; payload: AnalysisNeededPayload }
  | { type: 'codex-turn-stopped'; payload: CodexTurnStoppedPayload }
  | { type: 'user-interaction'; payload: UserInteractionPayload };

export interface PaneStatusTrackerConfig {
  paneId: string;
  tmuxPaneId: string;
  agent?: AgentName;
  worktreePath?: string;
}

export interface AnalysisCompleteInput {
  status?: PaneStatus;
  delayBeforeNextCheck?: number;
}

export interface AnalysisCompleteResult {
  events: PaneStatusEvent[];
  /** How long the caller should hold off the next observation, if at all. */
  pauseMs?: number;
}

const CAPTURE_HISTORY_LIMIT = 5;
const USER_TYPING_SETTLE_MS = 3500;
const AGENT_ACTIVITY_SETTLE_MS = 1500;
const ANALYSIS_COOLDOWN_MS = 5000;
const WORKING_INDICATOR_LINES = 20;

/**
 * The per-pane attention state machine, with no I/O of its own.
 *
 * It was previously fused to a worker thread, one per pane, which is what made
 * the fleet expensive: the logic here needs no isolate, only a string and a
 * clock. Callers capture pane text however they like — polling, control mode,
 * a test — and hand it to `observe`. Reading the codex event file stays outside
 * for the same reason; pass the parsed event in.
 */
export class PaneStatusTracker {
  readonly paneId: string;
  readonly tmuxPaneId: string;
  readonly codexEventFile?: string;

  private readonly agent?: AgentName;
  private captureHistory: Array<{ raw: string; fingerprint: string }> = [];
  private currentStatus: PaneStatus = 'idle';
  private statusBeforeAnalyzing: Exclude<PaneStatus, 'analyzing'> = 'idle';
  private lastStaticContent = '';
  private lastStaticFingerprint = '';
  private lastAnalysisTime = 0;
  private settledStateConfirmed = false;
  private lastUserInteractionAt = 0;
  private lastAgentActivityAt = 0;
  private awaitingAgentAfterUserInteraction = false;
  private lastCodexEventTimestamp = 0;
  private lastCodexEventTurnId = '';

  constructor(config: PaneStatusTrackerConfig) {
    this.paneId = config.paneId;
    this.tmuxPaneId = config.tmuxPaneId;
    this.agent = config.agent;
    this.codexEventFile = config.agent === 'codex' && config.worktreePath
      ? path.join(config.worktreePath, '.codex', 'psyche', `${config.paneId}.json`)
      : undefined;
  }

  get status(): PaneStatus {
    return this.currentStatus;
  }

  /**
   * Folds one capture into the pane's state.
   *
   * `codexEvent` is the parsed contents of `codexEventFile`, when the caller
   * has it; a codex turn ending short-circuits the rest of the tick exactly as
   * it did when the worker read the file itself.
   */
  observe(output: string, now: number, codexEvent?: unknown): PaneStatusEvent[] {
    const fingerprint = buildPaneActivityFingerprint(output);

    const codexEvents = this.applyCodexEvent(codexEvent, output, fingerprint);
    if (codexEvents) return codexEvents;

    const recentLines = output.split('\n').slice(-WORKING_INDICATOR_LINES).join('\n');
    if (hasAgentWorkingIndicators(recentLines, this.agent)) {
      return this.markAgentActive(output, fingerprint, now);
    }

    this.captureHistory.push({ raw: output, fingerprint });
    if (this.captureHistory.length > CAPTURE_HISTORY_LIMIT) {
      this.captureHistory.shift();
    }

    // Three captures is the minimum that can distinguish movement from stillness.
    if (this.captureHistory.length < 3) return [];

    const hasActivity = !this.captureHistory.every(
      (capture) => capture.fingerprint === this.captureHistory[0]?.fingerprint,
    );

    if (hasActivity) {
      const previousCapture = this.captureHistory[this.captureHistory.length - 2]?.raw || '';
      if (isLikelyUserTyping(previousCapture, output)) {
        return this.handleUserInteraction(output, fingerprint, now);
      }
      return this.markAgentActive(output, fingerprint, now);
    }

    return this.handleStaticTerminal(now);
  }

  /** Applies the analyzer's verdict and reports any requested cooldown. */
  onAnalysisComplete(input: AnalysisCompleteInput): AnalysisCompleteResult {
    if (!input?.status) return { events: [] };

    const events = this.updateStatus(input.status);
    this.settledStateConfirmed = input.status === 'idle' || input.status === 'waiting';

    return input.delayBeforeNextCheck && input.delayBeforeNextCheck > 0
      ? { events, pauseMs: input.delayBeforeNextCheck }
      : { events };
  }

  /**
   * Keys sent on the user's behalf change the pane, so the comparison history
   * is worthless and the pane counts as touched by a human.
   */
  onKeysSent(now: number): PaneStatusEvent[] {
    this.captureHistory = [];
    this.lastStaticFingerprint = '';
    return this.handleUserInteraction('', '', now);
  }

  private handleStaticTerminal(now: number): PaneStatusEvent[] {
    const staticCapture = this.captureHistory[this.captureHistory.length - 1];
    const staticContent = staticCapture?.raw || '';
    const staticFingerprint = staticCapture?.fingerprint || '';

    if (now - this.lastUserInteractionAt < USER_TYPING_SETTLE_MS) return [];
    if (now - this.lastAgentActivityAt < AGENT_ACTIVITY_SETTLE_MS) return [];
    if (this.awaitingAgentAfterUserInteraction) return [];
    if (staticFingerprint === this.lastStaticFingerprint) return [];

    this.lastStaticContent = staticContent;
    this.lastStaticFingerprint = staticFingerprint;

    if (this.settledStateConfirmed) return [];
    if (now - this.lastAnalysisTime < ANALYSIS_COOLDOWN_MS) return [];
    if (this.currentStatus === 'analyzing') return [];

    return this.transitionToAnalyzing(staticContent, 'new-static-content', now);
  }

  private markAgentActive(output: string, fingerprint: string, now: number): PaneStatusEvent[] {
    this.awaitingAgentAfterUserInteraction = false;
    this.settledStateConfirmed = false;
    this.lastAgentActivityAt = now;
    this.lastStaticContent = '';
    this.lastStaticFingerprint = '';
    this.captureHistory = [{ raw: output, fingerprint }];

    return this.currentStatus === 'working' ? [] : this.updateStatus('working');
  }

  private handleUserInteraction(
    output: string,
    fingerprint: string,
    now: number,
  ): PaneStatusEvent[] {
    this.lastUserInteractionAt = now;
    this.awaitingAgentAfterUserInteraction = true;
    this.settledStateConfirmed = false;
    this.lastStaticContent = output;
    this.lastStaticFingerprint = fingerprint;
    this.captureHistory = [{ raw: output, fingerprint }];

    const events: PaneStatusEvent[] = this.currentStatus === 'analyzing'
      ? this.updateStatus(this.statusBeforeAnalyzing)
      : [];

    const payload: UserInteractionPayload = {};
    if (output) payload.captureSnapshot = output;
    events.push({ type: 'user-interaction', payload });
    return events;
  }

  private updateStatus(newStatus: PaneStatus): PaneStatusEvent[] {
    const previousStatus = this.currentStatus;
    this.currentStatus = newStatus;

    return [{
      type: 'status-change',
      payload: {
        status: newStatus,
        previousStatus,
        captureSnapshot: this.captureHistory[this.captureHistory.length - 1]?.raw,
      },
    }];
  }

  private transitionToAnalyzing(
    content: string,
    reason: AnalysisNeededPayload['reason'],
    now: number,
  ): PaneStatusEvent[] {
    if (this.currentStatus !== 'analyzing') {
      this.statusBeforeAnalyzing = this.currentStatus;
    }
    const events = this.updateStatus('analyzing');
    this.lastAnalysisTime = now;
    events.push({ type: 'analysis-needed', payload: { captureSnapshot: content, reason } });
    return events;
  }

  /**
   * Returns the events for a newly observed codex turn end, or undefined when
   * the event is absent, stale, or addressed to a different pane — in which
   * case the tick proceeds normally.
   */
  private applyCodexEvent(
    raw: unknown,
    output: string,
    fingerprint: string,
  ): PaneStatusEvent[] | undefined {
    if (!this.codexEventFile || !raw || typeof raw !== 'object') return undefined;
    const event = raw as Record<string, unknown>;

    const timestamp = Number(event.timestamp || 0);
    const turnId = typeof event.turnId === 'string' ? event.turnId : '';
    if (!timestamp || timestamp < this.lastCodexEventTimestamp) return undefined;
    if (timestamp === this.lastCodexEventTimestamp && turnId === this.lastCodexEventTurnId) {
      return undefined;
    }
    if (event.psychePaneId !== this.paneId) return undefined;
    if (event.tmuxPaneId && event.tmuxPaneId !== this.tmuxPaneId) return undefined;

    this.lastCodexEventTimestamp = timestamp;
    this.lastCodexEventTurnId = turnId;
    this.awaitingAgentAfterUserInteraction = false;
    this.settledStateConfirmed = true;
    this.lastStaticContent = output;
    this.lastStaticFingerprint = fingerprint;
    this.captureHistory = [{ raw: output, fingerprint }];

    const previousStatus = this.currentStatus;
    this.currentStatus = 'idle';

    const payload: CodexTurnStoppedPayload = {
      captureSnapshot: output,
      eventFile: this.codexEventFile,
      source: typeof event.source === 'string' ? event.source : 'codex-hook',
    };
    if (turnId) payload.turnId = turnId;
    if (typeof event.sessionId === 'string' && event.sessionId.trim()) {
      payload.sessionId = event.sessionId;
    }
    if (typeof event.transcriptPath === 'string' && event.transcriptPath.trim()) {
      payload.transcriptPath = event.transcriptPath;
    }
    if (typeof event.cwd === 'string' && event.cwd.trim()) payload.cwd = event.cwd;
    if (timestamp) payload.timestamp = timestamp;
    if (typeof event.lastAssistantMessage === 'string' && event.lastAssistantMessage.trim()) {
      payload.lastAssistantMessage = event.lastAssistantMessage;
    }

    return [
      { type: 'status-change', payload: { status: 'idle', previousStatus, captureSnapshot: output } },
      { type: 'codex-turn-stopped', payload },
    ];
  }
}
