import { describe, expect, it } from 'vitest';
import { LaneLeaseStore } from '../src/control/leases.js';

describe('LaneLeaseStore', () => {
  it('increments revisions and rejects stale automation', () => {
    const leases = new LaneLeaseStore(() => new Date('2026-08-03T20:00:00Z'));
    const lease = leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    leases.takeover('%3', 'human-1');
    expect(() => leases.assertAutomation('%3', 'psyche-1', lease.revision))
      .toThrow('lease revision mismatch');
  });

  it('allows protocol-observed human input after takeover', () => {
    const leases = new LaneLeaseStore(() => new Date('2026-08-03T20:00:00Z'));
    leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    const takeover = leases.takeover('%3', 'human-1');
    expect(leases.assertHuman('%3', 'human-1', takeover.revision).actorId)
      .toBe('human-1');
  });

  it('hands out immutable lease objects', () => {
    const leases = new LaneLeaseStore(() => new Date('2026-08-03T20:00:00Z'));
    const lease = leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    expect(Object.isFrozen(lease)).toBe(true);
    try { (lease as { revision: number }).revision = 999; } catch { /* frozen */ }
    expect(leases.snapshot()['%3'].revision).toBe(lease.revision);
    expect(leases.assertAutomation('%3', 'psyche-1', lease.revision).actorId).toBe('psyche-1');
  });

  it('rejects an expired lease', () => {
    let now = new Date('2026-08-03T20:00:00Z').getTime();
    const leases = new LaneLeaseStore(() => new Date(now));
    const lease = leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    now += 60_001;
    expect(() => leases.assertAutomation('%3', 'psyche-1', lease.revision)).toThrow('lease expired');
  });
});
