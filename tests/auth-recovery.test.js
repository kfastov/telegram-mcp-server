vi.mock('@mtcute/node', () => ({
  TelegramClient: vi.fn(),
}));
// Spread the real module so the peer-resolution imports (MtPeerNotFoundError,
// toggleChannelIdMark, getMarkedPeerId) stay real; only InputMedia is stubbed.
vi.mock('@mtcute/core', async (importOriginal) => ({
  ...(await importOriginal()),
  InputMedia: {
    auto: vi.fn(),
  },
}));
vi.mock('@mtcute/markdown-parser', () => ({
  md: vi.fn((text) => text),
}));
vi.mock('@mtcute/html-parser', () => ({
  html: vi.fn((text) => text),
}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';

function makeDialog(peer, extra = {}) {
  return { peer, unreadCount: extra.unreadCount ?? 0, unreadMentionsCount: extra.unreadMentionsCount ?? 0 };
}

describe('telegram auth recovery', () => {
  let logSpy;
  let errorSpy;
  let warnSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('login routes existing sessions through client.start to complete mtcute login bootstrap', async () => {
    const tc = Object.create(TelegramClient.prototype);
    tc.options = { useQr: false, forceSms: false };
    tc.phoneNumber = '';
    tc.client = {
      start: vi.fn().mockResolvedValue({}),
    };
    tc._isAuthorized = vi.fn().mockResolvedValue(true);
    tc._buildStartParams = vi.fn().mockReturnValue({ bootstrap: true });

    const result = await tc.login();

    expect(result).toBe(true);
    expect(tc.client.start).toHaveBeenCalledWith({ bootstrap: true });
    expect(logSpy).toHaveBeenCalledWith('Existing session is valid.');
  });

  it('login retries once after session reset by recreating the MTProto client', async () => {
    const firstClient = {
      start: vi.fn().mockRejectedValue(new Error('Session is reset')),
    };
    const secondClient = {
      start: vi.fn().mockResolvedValue({}),
    };
    const tc = Object.create(TelegramClient.prototype);
    tc.options = { useQr: false, forceSms: false };
    tc.phoneNumber = '+1234567890';
    tc.client = firstClient;
    tc._isAuthorized = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    tc._buildStartParams = vi.fn().mockReturnValue({ phone: '+1234567890' });
    tc._isAuthKeyUnregisteredError = TelegramClient.prototype._isAuthKeyUnregisteredError;
    tc._isSessionResetError = TelegramClient.prototype._isSessionResetError;
    tc._recreateClient = vi.fn(async () => {
      tc.client = secondClient;
    });

    const result = await tc.login();

    expect(result).toBe(true);
    expect(tc._recreateClient).toHaveBeenCalledTimes(1);
    expect(firstClient.start).toHaveBeenCalledTimes(1);
    expect(secondClient.start).toHaveBeenCalledTimes(1);
  });

  it('listDialogs retries once after session reset and returns the recovered dialog list', async () => {
    const firstClient = {
      iterDialogs: async function* () {
        throw new Error('Session is reset');
      },
    };
    const secondClient = {
      iterDialogs: async function* () {
        yield makeDialog({
          id: 42,
          type: 'channel',
          username: 'tgcli',
          displayName: 'tgcli',
          chatType: 'channel',
          isForum: false,
          isGroup: false,
        });
      },
    };
    const tc = Object.create(TelegramClient.prototype);
    tc.client = firstClient;
    tc.ensureLogin = vi.fn().mockResolvedValue(undefined);
    tc.login = vi.fn().mockResolvedValue(true);
    tc._isSessionResetError = TelegramClient.prototype._isSessionResetError;
    tc._recreateClient = vi.fn(async () => {
      tc.client = secondClient;
    });

    const dialogs = await tc.listDialogs(10);

    expect(tc._recreateClient).toHaveBeenCalledTimes(1);
    expect(tc.login).toHaveBeenCalledTimes(1);
    expect(tc.ensureLogin).toHaveBeenCalledTimes(2);
    expect(dialogs).toEqual([
      {
        id: '42',
        type: 'channel',
        title: 'tgcli',
        username: 'tgcli',
        chatType: 'channel',
        isForum: false,
        isGroup: false,
        unreadCount: 0,
        unreadMentionsCount: 0,
      },
    ]);
  });
});
