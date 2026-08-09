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

  it('keeps proto at v2 and advertises all supported versions additively', () => {
    new BridgeBonjour().publish({
      name: 'test-host',
      port: 8443,
      serverId: 'server-1',
    });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      txt: {
        proto: '2',
        versions: '2,3',
        serverId: 'server-1',
      },
    }));
  });
});
