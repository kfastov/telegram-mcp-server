import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSendPhotoSuccessPayload, normalizeSendCommandError, parseNonNegativeInt, shouldRunMain, writeError } from '../cli.js';
import { SendCommandError, buildSendErrorPayload } from '../core/send-utils.js';

describe('tgcli send photo CLI validation', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('parses integer --retries values', () => {
    expect(parseNonNegativeInt('3', '--retries')).toBe(3);
    expect(parseNonNegativeInt('0', '--retries')).toBe(0);
  });

  it('treats symlinked bin paths as the CLI entrypoint', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-cli-entry-'));
    tempDirs.push(tempDir);
    const symlinkPath = path.join(tempDir, 'tgcli');
    fs.symlinkSync(path.resolve('cli.js'), symlinkPath);
    expect(shouldRunMain(symlinkPath)).toBe(true);
    expect(shouldRunMain(path.join(tempDir, 'not-cli'))).toBe(false);
  });

  it('uses the resolved peer id for photo JSON chat_id output', () => {
    expect(buildSendPhotoSuccessPayload({
      method: 'sendPhoto',
      inputChatId: '@some-alias',
      result: {
        chatId: '999',
        messageId: 123,
        media: { type: 'photo', fileId: 'photo-file-id' },
      },
      attempts: 2,
    })).toEqual({
      ok: true,
      method: 'sendPhoto',
      chat_id: '999',
      message_id: 123,
      media: { type: 'photo', file_id: 'photo-file-id' },
      attempts: 2,
    });
  });

  it('falls back to inputChatId when result.chatId is absent', () => {
    expect(buildSendPhotoSuccessPayload({
      method: 'sendPhoto',
      inputChatId: '@fallback-alias',
      result: {
        messageId: 789,
        media: { type: 'photo', fileId: 'some-id' },
      },
      attempts: 1,
    })).toEqual({
      ok: true,
      method: 'sendPhoto',
      chat_id: '@fallback-alias',
      message_id: 789,
      media: { type: 'photo', file_id: 'some-id' },
      attempts: 1,
    });
  });
});

describe('buildSendPhotoSuccessPayload with warning', () => {
  it('propagates warning from result into JSON payload', () => {
    const payload = buildSendPhotoSuccessPayload({
      method: 'sendPhoto',
      inputChatId: '@chat',
      result: {
        chatId: '999',
        messageId: 505,
        media: { type: 'photo' },
        warning: 'Media enrichment failed; file_id unavailable',
      },
      attempts: 1,
    });
    expect(payload.warning).toBe('Media enrichment failed; file_id unavailable');
    expect(payload.ok).toBe(true);
  });

  it('omits warning when result has no warning', () => {
    const payload = buildSendPhotoSuccessPayload({
      method: 'sendPhoto',
      inputChatId: '@chat',
      result: { chatId: '999', messageId: 123, media: { type: 'photo', fileId: 'abc' } },
      attempts: 1,
    });
    expect(payload).not.toHaveProperty('warning');
  });
});

describe('normalizeSendCommandError', () => {
  it('passes through SendCommandError as-is', () => {
    const details = { type: 'validation', method: 'sendPhoto', message: 'bad', attempt: 1, retries: 0 };
    const err = new SendCommandError(details);
    expect(normalizeSendCommandError(err, { method: 'sendPhoto' })).toBe(err);
  });

  it('does not wrap TypeError into SendCommandError', () => {
    const err = new TypeError('x is not a function');
    const result = normalizeSendCommandError(err, { method: 'sendPhoto' });
    expect(result).toBe(err);
    expect(result).toBeInstanceOf(TypeError);
  });

  it('wraps operational errors into SendCommandError', () => {
    const err = new Error('ECONNRESET');
    err.code = 'ECONNRESET';
    const result = normalizeSendCommandError(err, { method: 'sendPhoto', retries: 2 });
    expect(result).toBeInstanceOf(SendCommandError);
    expect(result.details).toMatchObject({ type: 'network', method: 'sendPhoto' });
  });
});

describe('writeError', () => {
  let stderrSpy;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('writes structured JSON to stderr for SendCommandError in JSON mode', () => {
    const details = { type: 'network', method: 'sendPhoto', message: 'ECONNRESET', code: 'ECONNRESET', attempt: 2, retries: 3 };
    const err = new SendCommandError(details);
    writeError(err, true);
    const written = JSON.parse(stderrSpy.mock.calls[0][0]);
    expect(written).toEqual(buildSendErrorPayload(details));
  });

  it('writes human-readable message to stderr for SendCommandError in text mode', () => {
    const details = { type: 'timeout', method: 'sendPhoto', message: 'Timeout', attempt: 1, retries: 0 };
    const err = new SendCommandError(details);
    writeError(err, false);
    expect(stderrSpy.mock.calls[0][0]).toContain('sendPhoto failed [timeout]');
  });

  it('writes generic JSON error for non-SendCommandError in JSON mode', () => {
    writeError(new Error('something broke'), true);
    const written = JSON.parse(stderrSpy.mock.calls[0][0]);
    expect(written).toEqual({ ok: false, error: 'something broke' });
  });
});

