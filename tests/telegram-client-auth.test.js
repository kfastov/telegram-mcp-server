const mtcuteClientCtor = vi.hoisted(() => vi.fn(function () {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
    onRawUpdate: { remove: vi.fn() },
  };
}));

vi.mock('@mtcute/node', () => ({
  TelegramClient: mtcuteClientCtor,
}));

// Spread the real module so the peer-resolution imports (MtPeerNotFoundError,
// toggleChannelIdMark, getMarkedPeerId) stay real; only InputMedia is stubbed.
vi.mock('@mtcute/core', async (importOriginal) => ({
  ...(await importOriginal()),
  InputMedia: {},
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';

describe('telegram client auth bootstrap options', () => {
  beforeEach(() => {
    mtcuteClientCtor.mockReset();
    mtcuteClientCtor.mockImplementation(function () {
      return {
        destroy: vi.fn().mockResolvedValue(undefined),
        stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
        onRawUpdate: { remove: vi.fn() },
      };
    });
  });

  it('disables mtcute updates when requested', () => {
    new TelegramClient(12345, 'hash', '+1234567890', '/tmp/tgcli-auth-disable-updates.session', {
      disableUpdates: true,
    });

    expect(mtcuteClientCtor).toHaveBeenCalledWith(expect.objectContaining({
      apiId: 12345,
      apiHash: 'hash',
      disableUpdates: true,
    }));
    expect(mtcuteClientCtor.mock.calls[0][0]).not.toHaveProperty('updates');
  });

  it('keeps updates configuration enabled by default', () => {
    new TelegramClient(12345, 'hash', '+1234567890', '/tmp/tgcli-auth-with-updates.session');

    expect(mtcuteClientCtor).toHaveBeenCalledWith(expect.objectContaining({
      apiId: 12345,
      apiHash: 'hash',
      updates: expect.objectContaining({
        catchUp: true,
      }),
    }));
    expect(mtcuteClientCtor.mock.calls[0][0]).not.toHaveProperty('disableUpdates');
  });
});
