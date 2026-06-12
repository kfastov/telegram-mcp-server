vi.mock('@mtcute/node', () => ({
  TelegramClient: vi.fn(),
}));
// Spread the real module so the peer-resolution imports (MtPeerNotFoundError,
// toggleChannelIdMark, getMarkedPeerId) stay real; only InputMedia is stubbed.
vi.mock('@mtcute/core', async (importOriginal) => ({
  ...(await importOriginal()),
  InputMedia: {
    auto: vi.fn((path, opts) => ({ path, ...opts })),
    photo: vi.fn((path, opts) => ({ path, ...opts })),
  },
}));
vi.mock('@mtcute/markdown-parser', () => ({
  md: vi.fn((text) => ({ text, entities: [{ type: 'bold' }] })),
}));
vi.mock('@mtcute/html-parser', () => ({
  html: vi.fn((text) => ({ text, entities: [{ type: 'italic' }] })),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { md } from '@mtcute/markdown-parser';
import { html } from '@mtcute/html-parser';
import TelegramClient from '../telegram-client.js';

// Send paths resolve the chat reference up front (resolveInputPeer) and hand
// mtcute the resolved input peer, not the raw '@chat' ref.
const RESOLVED_PEER = { _: 'inputPeerChannel', channelId: 999, accessHash: 1 };

function createMockClient() {
  const tc = Object.create(TelegramClient.prototype);
  tc.ensureLogin = vi.fn().mockResolvedValue(undefined);
  tc.client = {
    sendText: vi.fn().mockResolvedValue({ id: 101 }),
    sendMedia: vi.fn().mockResolvedValue({ id: 202 }),
    resolvePeer: vi.fn().mockResolvedValue(RESOLVED_PEER),
    _normalizeInputMedia: vi.fn(async (media) => ({ _: 'inputMediaUploadedPhoto', media })),
    call: vi.fn().mockResolvedValue({
      updates: [
        { _: 'updateMessageID', id: 202, randomId: { eq: () => true } },
        { _: 'updateNewChannelMessage', message: { id: 202 } },
      ],
    }),
    handleClientUpdate: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([{ id: 202, media: { type: 'photo', fileId: 'photo-file-id' } }]),
  };
  return tc;
}

function createTempFile(extension = '.txt') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-send-test-'));
  const filePath = path.join(dir, `sample${extension}`);
  fs.writeFileSync(filePath, 'sample file');
  return { dir, filePath };
}

describe('send message reply targeting', () => {
  let tc;
  let temp;

  beforeEach(() => {
    tc = createMockClient();
    temp = createTempFile();
  });

  afterEach(() => {
    fs.rmSync(temp.dir, { recursive: true, force: true });
  });

  it('sendTextMessage uses replyToMessageId when both replyToMessageId and topicId are provided', async () => {
    await tc.sendTextMessage('@chat', 'hello', {
      replyToMessageId: 77,
      topicId: 42,
    });
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'hello', { replyTo: 77 });
  });

  it('sendTextMessage falls back to topicId when replyToMessageId is missing', async () => {
    await tc.sendTextMessage('@chat', 'hello', { topicId: 42 });
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'hello', { replyTo: 42 });
  });

  it('sendFileMessage uses replyToMessageId when both replyToMessageId and topicId are provided', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, {
      replyToMessageId: 77,
      topicId: 42,
    });
    expect(tc.client.sendMedia).toHaveBeenCalledWith(RESOLVED_PEER, expect.anything(), { replyTo: 77 });
  });

  it('sendFileMessage falls back to topicId when replyToMessageId is missing', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { topicId: 42 });
    expect(tc.client.sendMedia).toHaveBeenCalledWith(RESOLVED_PEER, expect.anything(), { replyTo: 42 });
  });

  it('sendFileMessage sends without replyTo params when neither replyToMessageId nor topicId is provided', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, {});
    expect(tc.client.sendMedia).toHaveBeenCalledWith(RESOLVED_PEER, expect.anything(), undefined);
  });
});

describe('sendTextMessage parse-mode', () => {
  let tc;

  beforeEach(() => {
    tc = createMockClient();
    vi.clearAllMocks();
  });

  it('--parse-mode markdown calls md() and passes result to sendText', async () => {
    await tc.sendTextMessage('@chat', 'hello **bold**', { parseMode: 'markdown' });
    expect(md).toHaveBeenCalledTimes(1);
    expect(md).toHaveBeenCalledWith('hello **bold**');
    expect(tc.client.sendText).toHaveBeenCalledWith(
      RESOLVED_PEER,
      { text: 'hello **bold**', entities: [{ type: 'bold' }] },
      undefined,
    );
  });

  it('--parse-mode html calls html() and passes result to sendText', async () => {
    await tc.sendTextMessage('@chat', 'hello <b>bold</b>', { parseMode: 'html' });
    expect(html).toHaveBeenCalledTimes(1);
    expect(html).toHaveBeenCalledWith('hello <b>bold</b>');
    expect(tc.client.sendText).toHaveBeenCalledWith(
      RESOLVED_PEER,
      { text: 'hello <b>bold</b>', entities: [{ type: 'italic' }] },
      undefined,
    );
  });

  it('--parse-mode none sends text as-is without calling parsers', async () => {
    await tc.sendTextMessage('@chat', 'plain text', { parseMode: 'none' });
    expect(md).not.toHaveBeenCalled();
    expect(html).not.toHaveBeenCalled();
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'plain text', undefined);
  });

  it('no parseMode sends text as-is (backward compat)', async () => {
    await tc.sendTextMessage('@chat', 'plain text');
    expect(md).not.toHaveBeenCalled();
    expect(html).not.toHaveBeenCalled();
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'plain text', undefined);
  });

  it('parseMode is case-insensitive', async () => {
    await tc.sendTextMessage('@chat', '**bold**', { parseMode: 'Markdown' });
    expect(md).toHaveBeenCalledTimes(1);
  });

  it('invalid parseMode throws error', async () => {
    await expect(
      tc.sendTextMessage('@chat', 'text', { parseMode: 'xml' }),
    ).rejects.toThrow('Invalid parse mode. Allowed values: markdown, html, none');
  });

  it('empty message throws error', async () => {
    await expect(
      tc.sendTextMessage('@chat', '', { parseMode: 'markdown' }),
    ).rejects.toThrow('Message text cannot be empty.');
  });
});

describe('sendTextMessage new send parameters', () => {
  let tc;

  beforeEach(() => {
    tc = createMockClient();
  });

  it('--silent passes silent: true in params', async () => {
    await tc.sendTextMessage('@chat', 'hello', { silent: true });
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'hello', { silent: true });
  });

  it('--no-forwards passes forbidForwards: true in params', async () => {
    await tc.sendTextMessage('@chat', 'hello', { noforwards: true });
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'hello', { forbidForwards: true });
  });

  it('--schedule passes scheduleDate as unix timestamp in params', async () => {
    const scheduleDate = Math.floor(Date.now() / 1000) + 3600;
    await tc.sendTextMessage('@chat', 'hello', { scheduleDate });
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'hello', { scheduleDate });
  });

  it('combined silent + replyTo passes both in params', async () => {
    await tc.sendTextMessage('@chat', 'hello', { silent: true, replyToMessageId: 55 });
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'hello', { silent: true, replyTo: 55 });
  });

  it('noForwards (camelCase) passes forbidForwards: true in params', async () => {
    await tc.sendTextMessage('@chat', 'hello', { noForwards: true });
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'hello', { forbidForwards: true });
  });

  it('schedule (ISO string) passes scheduleDate as unix timestamp', async () => {
    const iso = '2027-01-15T09:00:00Z';
    const expected = Math.floor(new Date(iso).getTime() / 1000);
    await tc.sendTextMessage('@chat', 'hello', { schedule: iso });
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'hello', { scheduleDate: expected });
  });

  it('no new params still sends undefined params (backward compat)', async () => {
    await tc.sendTextMessage('@chat', 'hello');
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'hello', undefined);
  });
});

describe('sendFileMessage new send parameters', () => {
  let tc;
  let temp;

  beforeEach(() => {
    tc = createMockClient();
    temp = createTempFile();
  });

  afterEach(() => {
    fs.rmSync(temp.dir, { recursive: true, force: true });
  });

  it('--silent passes silent: true in params', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { silent: true });
    expect(tc.client.sendMedia).toHaveBeenCalledWith(RESOLVED_PEER, expect.anything(), { silent: true });
  });

  it('--no-forwards passes forbidForwards: true in params', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { noforwards: true });
    expect(tc.client.sendMedia).toHaveBeenCalledWith(RESOLVED_PEER, expect.anything(), { forbidForwards: true });
  });

  it('--caption-above passes invert: true in params', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { caption: 'my caption', captionAbove: true });
    expect(tc.client.sendMedia).toHaveBeenCalledWith(RESOLVED_PEER, expect.anything(), { invert: true });
  });

  it('--caption-above without caption throws error', async () => {
    await expect(
      tc.sendFileMessage('@chat', temp.filePath, { captionAbove: true }),
    ).rejects.toThrow('--caption-above requires --caption for send file');
  });

  it('--spoiler passes spoiler: true in InputMedia.auto options', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { spoiler: true });
    const { InputMedia } = await import('@mtcute/core');
    expect(InputMedia.auto).toHaveBeenCalledWith(
      expect.stringContaining('file:'),
      expect.objectContaining({ spoiler: true }),
    );
  });

  it('--force-document passes forceDocument: true in InputMedia.auto options', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { forceDocument: true });
    const { InputMedia } = await import('@mtcute/core');
    expect(InputMedia.auto).toHaveBeenCalledWith(
      expect.stringContaining('file:'),
      expect.objectContaining({ forceDocument: true }),
    );
  });

  it('no new params still sends undefined params (backward compat)', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, {});
    expect(tc.client.sendMedia).toHaveBeenCalledWith(RESOLVED_PEER, expect.anything(), undefined);
  });
});

describe('sendPhotoMessage', () => {
  let tc;
  let png;

  beforeEach(() => {
    tc = createMockClient();
    png = createTempFile('.png');
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(png.dir, { recursive: true, force: true });
  });

  it('sends local png via InputMedia.photo', async () => {
    await tc.sendPhotoMessage('@chat', png.filePath, {});
    const { InputMedia } = await import('@mtcute/core');
    expect(InputMedia.photo).toHaveBeenCalledWith(expect.stringContaining('file:'), {});
    expect(tc.client.resolvePeer).toHaveBeenCalledWith('@chat');
    expect(tc.client._normalizeInputMedia).toHaveBeenCalledTimes(1);
    expect(tc.client.call).toHaveBeenCalledTimes(1);
  });

  it('applies markdown parse mode to photo caption', async () => {
    await tc.sendPhotoMessage('@chat', png.filePath, { caption: '**caption**', parseMode: 'markdown' });
    const { InputMedia } = await import('@mtcute/core');
    expect(md).toHaveBeenCalledWith('**caption**');
    expect(InputMedia.photo).toHaveBeenCalledWith(
      expect.stringContaining('file:'),
      expect.objectContaining({
        caption: { text: '**caption**', entities: [{ type: 'bold' }] },
      }),
    );
  });

  it('passes send params to low-level sendMedia request', async () => {
    const scheduleDate = Math.floor(Date.now() / 1000) + 1800;
    await tc.sendPhotoMessage('@chat', png.filePath, {
      caption: 'preview',
      topicId: 42,
      replyToMessageId: 77,
      silent: true,
      noForwards: true,
      captionAbove: true,
      spoiler: true,
      scheduleDate,
    });
    expect(tc.client.call).toHaveBeenCalledWith(expect.objectContaining({
      _: 'messages.sendMedia',
      silent: true,
      scheduleDate,
      noforwards: true,
      invertMedia: true,
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: 77 },
    }));
  });

  it('rejects caption-above without caption for send photo', async () => {
    await expect(
      tc.sendPhotoMessage('@chat', png.filePath, { captionAbove: true }),
    ).rejects.toThrow('--caption-above requires --caption for send photo');
  });

  it('returns media metadata for successful photo sends', async () => {
    tc.client.call.mockResolvedValueOnce({
      updates: [
        { _: 'updateMessageID', id: 303, randomId: { eq: () => true } },
        { _: 'updateNewChannelMessage', message: { id: 303 } },
      ],
    });
    tc.client.getMessages.mockResolvedValueOnce([{ id: 303, media: { type: 'photo', fileId: 'photo-file-id' } }]);
    const result = await tc.sendPhotoMessage('@chat', png.filePath, {});
    expect(result).toMatchObject({ chatId: '999', messageId: 303, method: 'sendPhoto' });
  });

  it('does not fail when metadata lookup errors', async () => {
    tc.client.call.mockResolvedValueOnce({
      updates: [
        { _: 'updateMessageID', id: 505, randomId: { eq: () => true } },
        { _: 'updateNewChannelMessage', message: { id: 505 } },
      ],
    });
    tc.client.getMessages.mockRejectedValueOnce(new Error('lookup failed'));
    const result = await tc.sendPhotoMessage('@chat', png.filePath, {});
    expect(result).toMatchObject({ chatId: '999', messageId: 505, method: 'sendPhoto', warning: expect.any(String) });
  });

  it('throws when photo filePath does not exist', async () => {
    await expect(
      tc.sendPhotoMessage('@chat', '/tmp/nonexistent-photo-12345.png', {}),
    ).rejects.toThrow('File not found:');
  });

  it('throws when extractMessageIdFromSendUpdates returns null', async () => {
    tc.client.call.mockResolvedValueOnce({ updates: [] });
    await expect(
      tc.sendPhotoMessage('@chat', png.filePath, {}),
    ).rejects.toThrow('Failed to resolve sent photo message id from Telegram updates.');
  });

  it('does not upload during preparePhotoMessage', async () => {
    await tc.preparePhotoMessage('@chat', png.filePath, { caption: 'retry me' });
    expect(tc.client.resolvePeer).not.toHaveBeenCalled();
    expect(tc.client._normalizeInputMedia).not.toHaveBeenCalled();
  });
});

describe('resolveScheduleDate error handling', () => {
  let tc;

  beforeEach(() => {
    tc = createMockClient();
  });

  it('invalid ISO string throws error for sendTextMessage', async () => {
    await expect(
      tc.sendTextMessage('@chat', 'hello', { schedule: 'banana' }),
    ).rejects.toThrow('Invalid schedule date: must be a valid ISO 8601 datetime');
  });

  it('scheduleDate: 0 is treated as absent', async () => {
    await tc.sendTextMessage('@chat', 'hello', { scheduleDate: 0 });
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'hello', undefined);
  });

  it('scheduleDate: null is treated as absent', async () => {
    await tc.sendTextMessage('@chat', 'hello', { scheduleDate: null });
    expect(tc.client.sendText).toHaveBeenCalledWith(RESOLVED_PEER, 'hello', undefined);
  });
});
