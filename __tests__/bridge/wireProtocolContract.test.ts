import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE_TYPES,
  type ClientMessage,
  type ServerMessage,
} from '../../src/services/bridge/wireProtocol.js';

/**
 * Host half of the wire-protocol contract.
 *
 * The Swift client in native/ios hand-mirrors these types and reads the SAME
 * fixtures from protocol-fixtures/. Nothing in the build links the two
 * implementations, so a field renamed or a case added on one side is invisible
 * until a device fails to decode a real message. These fixtures are the link.
 *
 * The Swift counterpart is
 * native/ios/PsycheCore/Tests/PsycheCoreTests/WireProtocolContractTests.swift
 * and asserts the same three properties.
 */

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../protocol-fixtures',
);

function loadFixtures(file: string): Record<string, { type: string; payload: unknown }> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

const clientFixtures = loadFixtures('client-messages.json');
const serverFixtures = loadFixtures('server-messages.json');

/** Fixture keys may carry a `_variant` suffix; the wire type is the `type` field. */
function typesCovered(fixtures: Record<string, { type: string }>): Set<string> {
  return new Set(Object.values(fixtures).map((message) => message.type));
}

describe('wire protocol contract', () => {
  describe('fixture completeness', () => {
    // The anti-drift check. Add a case to the union and this names it as
    // missing until a fixture exists for the Swift side to decode too.
    it('covers every client message type', () => {
      const covered = typesCovered(clientFixtures);
      const missing = CLIENT_MESSAGE_TYPES.filter((type) => !covered.has(type));
      expect(missing).toEqual([]);
    });

    it('covers every server message type', () => {
      const covered = typesCovered(serverFixtures);
      const missing = SERVER_MESSAGE_TYPES.filter((type) => !covered.has(type));
      expect(missing).toEqual([]);
    });

    // Catches the reverse: a fixture for a type this side no longer declares,
    // which would otherwise sit there passing on the Swift side alone.
    it('has no fixture for an undeclared client type', () => {
      const declared = new Set<string>(CLIENT_MESSAGE_TYPES);
      expect([...typesCovered(clientFixtures)].filter((t) => !declared.has(t))).toEqual([]);
    });

    it('has no fixture for an undeclared server type', () => {
      const declared = new Set<string>(SERVER_MESSAGE_TYPES);
      expect([...typesCovered(serverFixtures)].filter((t) => !declared.has(t))).toEqual([]);
    });
  });

  describe('every fixture parses into the union', () => {
    it.each(Object.keys(clientFixtures))('client: %s', (name) => {
      const message = clientFixtures[name] as ClientMessage;
      expect(typeof message.type).toBe('string');
      expect(message).toHaveProperty('payload');
      expect((CLIENT_MESSAGE_TYPES as readonly string[])).toContain(message.type);
    });

    it.each(Object.keys(serverFixtures))('server: %s', (name) => {
      const message = serverFixtures[name] as ServerMessage;
      expect(typeof message.type).toBe('string');
      expect(message).toHaveProperty('payload');
      expect((SERVER_MESSAGE_TYPES as readonly string[])).toContain(message.type);
    });
  });

  describe('round-trip', () => {
    // Swift's JSONEncoder/JSONDecoder must reproduce the same value. If this
    // side cannot round-trip a fixture, the fixture is malformed and the Swift
    // failure would be far harder to read.
    it.each([...Object.keys(clientFixtures)])('client: %s survives re-encoding', (name) => {
      const original = clientFixtures[name];
      expect(JSON.parse(JSON.stringify(original))).toEqual(original);
    });

    it.each([...Object.keys(serverFixtures)])('server: %s survives re-encoding', (name) => {
      const original = serverFixtures[name];
      expect(JSON.parse(JSON.stringify(original))).toEqual(original);
    });
  });

  describe('field-level expectations the Swift side also asserts', () => {
    // Swift spells these properties paneID/clientID/projectID and maps them
    // with CodingKeys. The wire form is what both must agree on.
    it('uses the Id wire spelling, never ID', () => {
      const all = JSON.stringify({ ...clientFixtures, ...serverFixtures });
      expect(all).not.toMatch(/"[a-z]+ID"/);
      expect(all).toContain('"paneId"');
      expect(all).toContain('"clientId"');
      expect(all).toContain('"projectId"');
    });

    it('exercises null for every nullable field', () => {
      // A mirror can agree on the happy path and still disagree on absence.
      expect(clientFixtures.hello_noToken.payload).toMatchObject({ token: null });
      expect(clientFixtures.subscribePane_noSeq.payload).toMatchObject({ sinceSeq: null });
      expect(serverFixtures.welcome_noProject.payload).toMatchObject({ projectName: null });
      expect(serverFixtures.attention_noSummary.payload).toMatchObject({ summary: null });
    });

    it('pins the protocol version the fixtures were written against', () => {
      expect((clientFixtures.hello.payload as { protocolVersion: number }).protocolVersion).toBe(2);
      expect((serverFixtures.welcome.payload as { protocolVersion: number }).protocolVersion).toBe(2);
    });
  });
});
