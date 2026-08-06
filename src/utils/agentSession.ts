import { promises as fs } from 'fs';
import path from 'path';
import type { AgentSessionReference, PsycheConfig } from '../types.js';
import { atomicWriteJson } from './atomicWrite.js';
import { withPanesConfigWriteLock } from './panesConfigQueue.js';

export interface CodexSessionEventData {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  turnId?: string;
  source?: string;
  timestamp?: number;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function readCodexSessionIdFromTranscript(
  transcriptPath: string | undefined
): Promise<string | undefined> {
  if (!transcriptPath) return undefined;

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(transcriptPath, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!bytesRead) return undefined;

    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    if (!firstLine.trim()) return undefined;

    const event = JSON.parse(firstLine) as { payload?: Record<string, unknown> };
    return stringOrUndefined(event.payload?.id);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function deriveCodexSessionIdFromTranscriptPath(
  transcriptPath: string | undefined
): string | undefined {
  if (!transcriptPath) return undefined;
  const basename = path.basename(transcriptPath).replace(/\.jsonl$/i, '');
  return basename || undefined;
}

export async function buildCodexAgentSessionReference(
  event: CodexSessionEventData
): Promise<AgentSessionReference> {
  const transcriptPath = stringOrUndefined(event.transcriptPath);
  const explicitSessionId = stringOrUndefined(event.sessionId);
  const transcriptSessionId = await readCodexSessionIdFromTranscript(transcriptPath);
  const fallbackSessionId = deriveCodexSessionIdFromTranscriptPath(transcriptPath);
  const updatedAt = event.timestamp
    ? new Date(event.timestamp).toISOString()
    : new Date().toISOString();

  const reference: AgentSessionReference = {
    agent: 'codex',
    updatedAt,
  };

  const id = explicitSessionId || transcriptSessionId || fallbackSessionId;
  if (id) reference.id = id;
  if (transcriptPath) reference.transcriptPath = transcriptPath;

  const cwd = stringOrUndefined(event.cwd);
  if (cwd) reference.cwd = cwd;

  const turnId = stringOrUndefined(event.turnId);
  if (turnId) reference.lastTurnId = turnId;

  const source = stringOrUndefined(event.source);
  if (source) reference.source = source;

  return reference;
}

export async function persistPaneAgentSessionReference(
  panesFile: string | undefined,
  paneId: string,
  agentSession: AgentSessionReference
): Promise<void> {
  if (!panesFile) return;

  await withPanesConfigWriteLock(async () => {
    const raw = await fs.readFile(panesFile, 'utf8');
    const parsed = JSON.parse(raw) as PsycheConfig | PsycheConfig['panes'];
    if (Array.isArray(parsed)) return;

    const panes = Array.isArray(parsed.panes) ? parsed.panes : [];
    const pane = panes.find((candidate) => candidate.id === paneId || candidate.paneId === paneId);
    if (!pane) return;

    pane.agentSession = agentSession;
    parsed.panes = panes;
    parsed.lastUpdated = new Date().toISOString();
    await atomicWriteJson(panesFile, parsed);
  });
}
