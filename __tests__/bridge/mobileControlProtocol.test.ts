import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MOBILE_CONTROL_FIXTURES,
  WORKSPACE_SNAPSHOT_FIXTURE,
} from '../../protocol-fixtures/fixtures.js';
import { serialize } from '../../scripts/generate-protocol-fixtures.js';
import {
  CLIENT_MESSAGE_TYPES,
  LEGACY_PROTOCOL_VERSION,
  MOBILE_CONTROL_REQUEST_TYPES,
  MOBILE_CONTROL_RESPONSE_TYPES,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  SUPPORTED_PROTOCOL_VERSIONS,
  encodeMobileBinaryFrame,
  type ClientMessage,
  type LegacyClientMessage,
  type LegacyServerMessage,
  type MobileControlRequest,
  type MobileControlResponse,
  type ServerMessage,
} from '../../src/services/bridge/wireProtocol.js';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../protocol-fixtures',
);

describe('mobile control protocol v3', () => {
  it('pins the paired protocol versions', () => {
    expect(LEGACY_PROTOCOL_VERSION).toBe(2);
    expect(PROTOCOL_VERSION).toBe(3);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual([2, 3]);
  });

  it('keeps legacy v2 types while enumerating the new v3 envelopes', () => {
    expect(CLIENT_MESSAGE_TYPES).toContain('hello');
    expect(CLIENT_MESSAGE_TYPES).toContain('control');
    expect(SERVER_MESSAGE_TYPES).toContain('welcome');
    expect(SERVER_MESSAGE_TYPES).toContain('control');
    expect(SERVER_MESSAGE_TYPES).toContain('workspaceChanged');

    const legacyClient: LegacyClientMessage = {
      type: 'hello',
      payload: {
        clientId: 'ios-device-1',
        clientName: 'Psyche for iPhone',
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        token: null,
      },
    };
    const legacyServer: LegacyServerMessage = {
      type: 'welcome',
      payload: {
        serverId: 'srv-1',
        serverName: 'psyche-build',
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        projectName: 'psyche-build',
      },
    };

    const clientEnvelope: ClientMessage = legacyClient;
    const serverEnvelope: ServerMessage = legacyServer;

    expect(clientEnvelope.type).toBe('hello');
    expect(serverEnvelope.type).toBe('welcome');
  });

  it('wraps canonical workspace snapshot requests in the control envelope', () => {
    const request: MobileControlRequest = {
      type: 'workspace.snapshot',
      requestId: 'workspace-1',
    };
    const message: ClientMessage = { type: 'control', payload: request };

    expect(message).toEqual({
      type: 'control',
      payload: {
        type: 'workspace.snapshot',
        requestId: 'workspace-1',
      },
    });
  });

  it('wraps ack responses in the control envelope', () => {
    const response: MobileControlResponse = {
      type: 'ack',
      requestId: 'req-1',
      ok: true,
    };
    const message: ServerMessage = { type: 'control', payload: response };

    expect(message).toEqual({
      type: 'control',
      payload: {
        type: 'ack',
        requestId: 'req-1',
        ok: true,
      },
    });
  });

  it('exports the complete supported nested mobile control contract', () => {
    expect(MOBILE_CONTROL_REQUEST_TYPES).toEqual([
      'workspace.snapshot',
      'panes.detach',
      'panes.input',
      'panes.resize',
      'panes.kill',
      'panes.meta',
      'panes.spawn',
      'panes.attach',
      'files.list',
      'files.read',
      'files.diff',
      'actions.start',
      'actions.respond',
    ]);
    expect(MOBILE_CONTROL_RESPONSE_TYPES).toEqual([
      'ack',
      'panes.spawn.result',
      'panes.stream.exit',
      'error',
      'mobile.workspace.snapshot.result',
      'mobile.panes.attach.result',
      'files.list.result',
      'files.read.result',
      'files.diff.result',
      'actions.result',
    ]);
  });

  it('excludes unrelated daemon request and response families at compile time', () => {
    // @ts-expect-error projects.list is not part of the mobile v3 contract
    const unrelatedRequest: MobileControlRequest = { type: 'projects.list', requestId: 'project-1' };
    // @ts-expect-error capture results are not part of the mobile v3 contract
    const unrelatedResponse: MobileControlResponse = { type: 'panes.capture.result', requestId: 'capture-1', id: '%3', text: 'output', lines: 1 };

    expect(unrelatedRequest.type).toBe('projects.list');
    expect(unrelatedResponse.type).toBe('panes.capture.result');
  });

  it('keeps the mobile control fixtures in sync with generated JSON', () => {
    const fixturePath = path.join(FIXTURE_DIR, 'mobile-control.json');
    expect(fs.readFileSync(fixturePath, 'utf8')).toBe(serialize(MOBILE_CONTROL_FIXTURES));
  });

  it('reuses the canonical workspace snapshot fixture in workspaceChanged', () => {
    expect(MOBILE_CONTROL_FIXTURES.workspaceChanged).toEqual({
      type: 'workspaceChanged',
      payload: {
        revision: 42,
        sequence: 7,
        workspace: WORKSPACE_SNAPSHOT_FIXTURE.workspace,
      },
    });
  });

  it('captures custom pane attach and spawn control requests', () => {
    expect(MOBILE_CONTROL_FIXTURES.attachAgentPane).toEqual({
      type: 'control',
      payload: {
        type: 'panes.attach',
        requestId: 'attach-1',
        id: '%3',
        cols: 100,
        rows: 32,
        sinceSeq: 12,
      },
    });

    expect(MOBILE_CONTROL_FIXTURES.spawnAgentPane).toEqual({
      type: 'control',
      payload: {
        type: 'panes.spawn',
        requestId: 'spawn-1',
        idempotencyKey: 'spawn-agent-1',
        kind: 'agent',
        projectId: '/repo',
        cwd: '/repo',
        branch: undefined,
        startPointBranch: undefined,
        existingWorktree: undefined,
        agent: 'coven-code',
        title: 'Implement mobile cockpit',
        prompt: 'Add the paired protocol-v3 control envelope.',
      },
    });
  });

  it('encodes binary frames with stream metadata and a big-endian sequence', () => {
    const frame = encodeMobileBinaryFrame('pane-1', 258, Uint8Array.from([0xde, 0xad]));
    const idLength = Buffer.byteLength('pane-1', 'utf8');

    expect(frame.readUInt8(0)).toBe(idLength);
    expect(frame.subarray(1, 1 + idLength).toString('utf8')).toBe('pane-1');
    expect(frame.readBigUInt64BE(1 + idLength)).toBe(258n);
    expect([...frame.subarray(1 + idLength + 8)]).toEqual([0xde, 0xad]);
  });

  it('rejects invalid binary frame metadata', () => {
    expect(() => encodeMobileBinaryFrame('', 0, new Uint8Array())).toThrow('streamId must not be empty');
    expect(() => encodeMobileBinaryFrame('x'.repeat(256), 0, new Uint8Array())).toThrow('streamId too long');
    expect(() => encodeMobileBinaryFrame('pane-1', -1, new Uint8Array())).toThrow('sequence must be a non-negative safe integer');
    expect(() => encodeMobileBinaryFrame('pane-1', Number.MAX_SAFE_INTEGER + 1, new Uint8Array())).toThrow('sequence must be a non-negative safe integer');
  });
});
