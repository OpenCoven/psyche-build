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
import { CLIENT_FIXTURES, MOBILE_CONTROL_FIXTURES, SERVER_FIXTURES } from '../../protocol-fixtures/fixtures.js';
import { serialize } from '../../scripts/generate-protocol-fixtures.js';

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
const mobileControlFixtures = loadFixtures('mobile-control.json');

/** Fixture keys may carry a `_variant` suffix; the wire type is the `type` field. */
function typesCovered(fixtures: Record<string, { type: string }>): Set<string> {
  return new Set(Object.values(fixtures).map((message) => message.type));
}

describe('wire protocol contract', () => {
  describe('fixture completeness', () => {
    // The anti-drift check. Add a case to the union and this names it as
    // missing until a fixture exists for the Swift side to decode too.
    it('covers every client message type', () => {
      const covered = new Set([...typesCovered(clientFixtures), ...typesCovered(mobileControlFixtures)]);
      const missing = CLIENT_MESSAGE_TYPES.filter((type) => !covered.has(type));
      expect(missing).toEqual([]);
    });

    it('covers every server message type', () => {
      const covered = new Set([...typesCovered(serverFixtures), ...typesCovered(mobileControlFixtures)]);
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

    it('has no mobile control fixture for an undeclared top-level type', () => {
      const declared = new Set<string>([...CLIENT_MESSAGE_TYPES, ...SERVER_MESSAGE_TYPES]);
      expect([...typesCovered(mobileControlFixtures)].filter((t) => !declared.has(t))).toEqual([]);
    });
  });

  describe('every fixture parses into the union', () => {
    // decodeClientMessage rejects a null or array payload outright, so assert
    // the same precondition here — otherwise a fixture with `payload: []`
    // passes this test and still blows up at runtime.
    it.each(Object.keys(clientFixtures))('client: %s', (name) => {
      const message = clientFixtures[name] as ClientMessage;
      expect(typeof message.type).toBe('string');
      expect((CLIENT_MESSAGE_TYPES as readonly string[])).toContain(message.type);

      const payload = (message as { payload: unknown }).payload;
      expect(payload).not.toBeNull();
      expect(typeof payload).toBe('object');
      expect(Array.isArray(payload)).toBe(false);
    });

    // Server payloads are deliberately looser: paneList and projectList carry
    // arrays. Assert object-or-array, and pin which types are the array ones.
    const ARRAY_PAYLOAD_TYPES = new Set(['paneList', 'paneListChanged', 'projectList']);

    it.each(Object.keys(serverFixtures))('server: %s', (name) => {
      const message = serverFixtures[name] as ServerMessage;
      expect(typeof message.type).toBe('string');
      expect((SERVER_MESSAGE_TYPES as readonly string[])).toContain(message.type);

      const payload = (message as { payload: unknown }).payload;
      expect(payload).not.toBeNull();
      expect(typeof payload).toBe('object');
      expect(Array.isArray(payload)).toBe(ARRAY_PAYLOAD_TYPES.has(message.type));
    });
  });

  describe('mobile control fixtures', () => {
    it.each(Object.keys(mobileControlFixtures))('%s uses a declared top-level envelope', (name) => {
      const message = mobileControlFixtures[name] as ClientMessage | ServerMessage;
      expect(typeof message.type).toBe('string');
      expect([...new Set<string>([...CLIENT_MESSAGE_TYPES, ...SERVER_MESSAGE_TYPES])]).toContain(message.type);
      expect((message as { payload: unknown }).payload).toBeTruthy();
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

    it.each([...Object.keys(mobileControlFixtures)])('mobile control: %s survives re-encoding', (name) => {
      const original = mobileControlFixtures[name];
      expect(JSON.parse(JSON.stringify(original))).toEqual(original);
    });
  });

  describe('field-level expectations the Swift side also asserts', () => {
    // Swift spells these properties paneID/clientID/projectID and maps them
    // with CodingKeys. The wire form is what both must agree on.
    it('uses the Id wire spelling, never ID', () => {
      const all = JSON.stringify({ ...clientFixtures, ...serverFixtures });
      // Trailing colon constrains this to object keys. Without it a *value*
      // like "someID" false-positives, so the assertion would fail for a
      // reason that has nothing to do with the wire contract.
      expect(all).not.toMatch(/"[A-Za-z]*ID":/);
      expect(all).toMatch(/"paneId":/);
      expect(all).toMatch(/"clientId":/);
      expect(all).toMatch(/"projectId":/);
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

  describe('generated JSON tracks the typed source', () => {
    // fixtures.ts is compile-checked against the unions; the JSON is what Swift
    // reads. If they diverge, the Swift suite is testing something the host no
    // longer describes — so the checked-in JSON must be exactly what the source
    // emits.
    it('client-messages.json is up to date', () => {
      const onDisk = fs.readFileSync(path.join(FIXTURE_DIR, 'client-messages.json'), 'utf8');
      expect(onDisk).toBe(serialize(CLIENT_FIXTURES));
    });

    it('server-messages.json is up to date', () => {
      const onDisk = fs.readFileSync(path.join(FIXTURE_DIR, 'server-messages.json'), 'utf8');
      expect(onDisk).toBe(serialize(SERVER_FIXTURES));
    });

    it('mobile-control.json is up to date', () => {
      const onDisk = fs.readFileSync(path.join(FIXTURE_DIR, 'mobile-control.json'), 'utf8');
      expect(onDisk).toBe(serialize(MOBILE_CONTROL_FIXTURES));
    });
  });

});
