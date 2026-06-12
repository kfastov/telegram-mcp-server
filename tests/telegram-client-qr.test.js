const qrcodeMock = vi.hoisted(() => ({
  toString: vi.fn(),
  toFile: vi.fn(),
  toDataURL: vi.fn(),
}));

const mtcuteClientCtor = vi.hoisted(() => vi.fn(function () {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
    onRawUpdate: { remove: vi.fn() },
  };
}));

vi.mock('qrcode', () => ({
  default: qrcodeMock,
  toString: qrcodeMock.toString,
  toFile: qrcodeMock.toFile,
  toDataURL: qrcodeMock.toDataURL,
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';

describe('telegram client qr auth output', () => {
  let logSpy;
  let stderrWriteSpy;

  beforeEach(() => {
    qrcodeMock.toString.mockReset().mockResolvedValue('terminal-qr');
    qrcodeMock.toFile.mockReset().mockResolvedValue(undefined);
    qrcodeMock.toDataURL.mockReset().mockResolvedValue('data:image/png;base64,abc');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    logSpy.mockRestore();
    stderrWriteSpy.mockRestore();
  });

  it('renders terminal QR output and saves the PNG when requested', async () => {
    const client = Object.create(TelegramClient.prototype);
    client.options = {
      useQr: true,
      json: false,
      qrFilePath: '/tmp/tgcli-qr-auth.png',
    };

    const { qrCodeHandler } = client._buildStartParams();
    await qrCodeHandler('tg://login?token=abc', new Date('2026-04-02T00:00:00.000Z'));

    expect(qrcodeMock.toString).toHaveBeenCalledWith('tg://login?token=abc', {
      type: 'terminal',
      small: true,
    });
    expect(qrcodeMock.toFile).toHaveBeenCalledWith('/tmp/tgcli-qr-auth.png', 'tg://login?token=abc', {
      type: 'png',
      width: 300,
    });
    expect(logSpy).toHaveBeenCalledWith('\nScan this QR code in Telegram: Settings -> Devices -> Link Desktop Device');
    expect(logSpy).toHaveBeenCalledWith('terminal-qr');
    expect(logSpy).toHaveBeenCalledWith('QR login URL: tg://login?token=abc');
    expect(logSpy).toHaveBeenCalledWith('QR expires at: 2026-04-02T00:00:00.000Z');
    expect(logSpy).toHaveBeenCalledWith('QR saved to: /tmp/tgcli-qr-auth.png');
    expect(stderrWriteSpy).not.toHaveBeenCalled();
  });

  it('emits qr events to stderr in json mode and handles refreshed QR codes', async () => {
    const client = Object.create(TelegramClient.prototype);
    client.options = {
      useQr: true,
      json: true,
      qrFilePath: '/tmp/tgcli-qr-auth.png',
    };

    const { qrCodeHandler } = client._buildStartParams();
    await qrCodeHandler('tg://login?token=first', new Date('2026-04-02T00:00:00.000Z'));
    await qrCodeHandler('tg://login?token=second', new Date('2026-04-02T00:05:00.000Z'));

    expect(qrcodeMock.toString).not.toHaveBeenCalled();
    expect(qrcodeMock.toFile).toHaveBeenNthCalledWith(1, '/tmp/tgcli-qr-auth.png', 'tg://login?token=first', {
      type: 'png',
      width: 300,
    });
    expect(qrcodeMock.toFile).toHaveBeenNthCalledWith(2, '/tmp/tgcli-qr-auth.png', 'tg://login?token=second', {
      type: 'png',
      width: 300,
    });
    expect(logSpy).not.toHaveBeenCalled();

    const writes = stderrWriteSpy.mock.calls.map(([chunk]) => JSON.parse(String(chunk).trim()));
    expect(writes).toEqual([
      {
        event: 'qr',
        url: 'tg://login?token=first',
        expiresAt: '2026-04-02T00:00:00.000Z',
        qrFile: '/tmp/tgcli-qr-auth.png',
      },
      {
        event: 'qr',
        url: 'tg://login?token=second',
        expiresAt: '2026-04-02T00:05:00.000Z',
        qrFile: '/tmp/tgcli-qr-auth.png',
      },
    ]);
  });
});
