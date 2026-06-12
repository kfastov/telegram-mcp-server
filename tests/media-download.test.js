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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { setImmediate as setImmediateAsync } from 'timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';

function makeChunks(chunkSize, chunkCount) {
  const chunks = [];
  for (let i = 0; i < chunkCount; i += 1) {
    chunks.push(new Uint8Array(chunkSize).fill(i % 256));
  }
  return chunks;
}

function makeDocumentMessage() {
  return {
    media: {
      type: 'document',
      mimeType: 'application/pdf',
      fileName: 'doc.pdf',
      location: { _: 'inputDocumentFileLocation' },
    },
  };
}

function createClient({ message, downloadAsNodeStream }) {
  const client = new TelegramClient(12345, 'hash', '+1234567890', '/tmp/tgcli-media-download.session');
  client.ensureLogin = async () => {};
  client.client = {
    resolvePeer: vi.fn().mockResolvedValue({ _: 'inputPeerUser', userId: 123, accessHash: 0 }),
    getMessages: vi.fn().mockResolvedValue([message]),
    downloadAsNodeStream,
  };
  return client;
}

describe('downloadMessageMedia', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-media-download-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the same byte count as the file on disk', async () => {
    const chunks = makeChunks(8192, 10); // ~80 KB across multiple chunks
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const client = createClient({
      message: makeDocumentMessage(),
      downloadAsNodeStream: vi.fn(() => Readable.from(chunks)),
    });

    const result = await client.downloadMessageMedia('123', 5, { outputPath: tmpDir });

    expect(result.path).toBe(path.join(tmpDir, 'doc.pdf'));
    expect(result.bytes).toBe(totalBytes);
    expect(result.bytes).toBe(fs.statSync(result.path).size);
    expect(fs.readFileSync(result.path)).toEqual(Buffer.concat(chunks));
    expect(result.mimeType).toBe('application/pdf');
  });

  it('waits for the full flush when chunks arrive slowly', async () => {
    const chunks = makeChunks(8192, 6);
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    async function* slowChunks() {
      for (const chunk of chunks) {
        await setImmediateAsync();
        yield chunk;
      }
    }
    const client = createClient({
      message: makeDocumentMessage(),
      downloadAsNodeStream: vi.fn(() => Readable.from(slowChunks())),
    });

    const result = await client.downloadMessageMedia('123', 5, { outputPath: tmpDir });

    expect(result.bytes).toBe(totalBytes);
    expect(result.bytes).toBe(fs.statSync(result.path).size);
  });

  it('rejects on download error without leaving a partial file', async () => {
    async function* failingChunks() {
      yield new Uint8Array(8192).fill(1);
      throw new Error('connection lost');
    }
    const client = createClient({
      message: makeDocumentMessage(),
      downloadAsNodeStream: vi.fn(() => Readable.from(failingChunks())),
    });

    await expect(client.downloadMessageMedia('123', 5, { outputPath: tmpDir }))
      .rejects.toThrow('connection lost');
    expect(fs.existsSync(path.join(tmpDir, 'doc.pdf'))).toBe(false);
  });
});
