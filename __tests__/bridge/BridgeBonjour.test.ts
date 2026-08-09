import { beforeEach, describe, expect, it, vi } from 'vitest';

const publish = vi.fn(() => ({ stop: vi.fn() }));

vi.mock('bonjour-service', () => ({
  Bonjour: class {
    publish = publish;
    destroy = vi.fn();
  },
}));

import { BridgeBonjour } from '../../src/services/bridge/BridgeBonjour.js';

describe('BridgeBonjour', () => {
  beforeEach(() => {
    publish.mockClear();
  });

  it('publishes exact discovery identity and protocol metadata', () => {
    new BridgeBonjour().publish({
      name: 'test-host',
      port: 8443,
      serverId: 'server-1',
      fingerprint: 'AA:BB:CC:DD',
    });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      txt: {
        proto: '2',
        versions: '2,3',
        serverId: 'server-1',
        fingerprint: 'AA:BB:CC:DD',
      },
    }));
  });
});
