import { describe, expect, it } from 'vitest';
import {
  getProcessStartIdentity,
  normalizeProcessStartIdentity,
} from '../src/services/ProcessIdentity.js';

function restoreEnvironment(
  name: 'TZ' | 'LC_ALL' | 'LANG',
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe.sequential('process start identity', () => {
  it('uses one canonical identity for a live PID across parent time zones', () => {
    const original = {
      TZ: process.env.TZ,
      LC_ALL: process.env.LC_ALL,
      LANG: process.env.LANG,
    };

    try {
      process.env.TZ = 'Pacific/Auckland';
      process.env.LC_ALL = 'fr_FR.UTF-8';
      process.env.LANG = 'fr_FR.UTF-8';
      const westernIdentity = getProcessStartIdentity(process.pid);

      process.env.TZ = 'America/Los_Angeles';
      process.env.LC_ALL = 'de_DE.UTF-8';
      process.env.LANG = 'de_DE.UTF-8';
      const easternIdentity = getProcessStartIdentity(process.pid);

      expect(westernIdentity).toBeTruthy();
      expect(easternIdentity).toBe(westernIdentity);
    } finally {
      restoreEnvironment('TZ', original.TZ);
      restoreEnvironment('LC_ALL', original.LC_ALL);
      restoreEnvironment('LANG', original.LANG);
    }
  });

  it('normalizes ps whitespace before a token is persisted', () => {
    expect(normalizeProcessStartIdentity('  Fri Apr  4  09:30:00  2025\r\n'))
      .toBe('Fri Apr 4 09:30:00 2025');
  });
});
