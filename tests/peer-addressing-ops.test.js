// End-to-end coverage of positive-id addressing through the real operation
// registry (core/operations.js): each op runs against a real TelegramClient
// instance whose fake mtcute inner client only resolves the canonical negative
// form, mirroring how a plain group chat behaves when addressed by its bare
// positive id.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MtPeerNotFoundError, toggleChannelIdMark } from '@mtcute/core';

import TelegramClient from '../telegram-client.js';
import { OPERATIONS } from '../core/operations.js';

const GROUP_ID = '4701666782';
const CANONICAL_ID = `-${GROUP_ID}`;
const INPUT_PEER_CHAT = { _: 'inputPeerChat', chatId: Number(GROUP_ID) };

function groupResolvePeer() {
  return vi.fn(async (ref) => {
    if (ref === -Number(GROUP_ID)) {
      return INPUT_PEER_CHAT;
    }
    throw new MtPeerNotFoundError(`Peer ${ref} is not found in local cache`);
  });
}

// Peer storage holding the basic chat (as after a dialog sync), so the
// existence probe for the structurally-resolved chat form passes locally.
function cachedChatStorage() {
  return {
    peers: {
      getById: vi.fn(async (id) => (id === -Number(GROUP_ID) ? INPUT_PEER_CHAT : null)),
    },
  };
}

function searchResults(messages) {
  const results = [...messages];
  results.total = messages.length;
  results.next = null;
  return results;
}

// Real TelegramClient methods over a fake mtcute inner client.
function makeTelegramClient(inner = {}) {
  const tc = Object.create(TelegramClient.prototype);
  tc.ensureLogin = vi.fn().mockResolvedValue(undefined);
  tc.client = { resolvePeer: groupResolvePeer(), storage: cachedChatStorage(), ...inner };
  return tc;
}

// Archive stub: metadata is cached so live ops never need a metadata roundtrip
// unless a test overrides it.
function makeSyncService(overrides = {}) {
  return {
    getChannelMetadata: vi.fn(() => ({ peerTitle: 'Group', username: 'grp' })),
    getChannel: vi.fn(() => null),
    listArchivedMessages: vi.fn(() => []),
    searchArchiveMessages: vi.fn(() => []),
    getArchivedMessage: vi.fn(() => null),
    getArchivedMessageContext: vi.fn(() => ({ target: null, before: [], after: [] })),
    listTaggedChannels: vi.fn(() => []),
    resolveArchiveChannelKey: vi.fn((id) => String(id)),
    setChannelSync: vi.fn((id) => ({ channel_id: String(id), sync_enabled: 1 })),
    listJobs: vi.fn(() => []),
    addJob: vi.fn((id) => ({ id: 7, channel_id: String(id), status: 'pending' })),
    processQueue: vi.fn(),
    ...overrides,
  };
}

describe('positive-id addressing through the operation registry', () => {
  it('messagesSearch source=live returns live messages for a positive group id', async () => {
    const searchMessages = vi.fn().mockResolvedValue(
      searchResults([{ id: 10, date: 1700000000, text: 'x marks the spot' }]),
    );
    const ctx = {
      telegramClient: makeTelegramClient({ searchMessages }),
      messageSyncService: makeSyncService(),
    };

    const result = await OPERATIONS.messagesSearch(ctx, {
      channelId: GROUP_ID,
      source: 'live',
      query: 'x',
    });

    expect(searchMessages.mock.calls[0][0].chatId).toBe(INPUT_PEER_CHAT);
    expect(result.source).toBe('live');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('x marks the spot');
  });

  it('messagesSearch source=archive falls back to live when the archive is empty', async () => {
    const searchMessages = vi.fn().mockResolvedValue(
      searchResults([{ id: 11, date: 1700000000, text: 'fallback hit' }]),
    );
    const ctx = {
      telegramClient: makeTelegramClient({ searchMessages }),
      messageSyncService: makeSyncService(),
    };

    const result = await OPERATIONS.messagesSearch(ctx, {
      channelId: GROUP_ID,
      source: 'archive',
      query: 'fallback',
    });

    expect(ctx.messageSyncService.searchArchiveMessages).toHaveBeenCalledTimes(1);
    expect(result.usedLiveFallback).toBe(true);
    expect(result.source).toBe('live');
    expect(result.messages).toHaveLength(1);
  });

  it('messagesList source=live works with a positive group id', async () => {
    const iterHistory = vi.fn(() => (async function* () {
      yield { id: 5, date: 1700000000, text: 'listed' };
    })());
    const ctx = {
      telegramClient: makeTelegramClient({ iterHistory }),
      messageSyncService: makeSyncService(),
    };

    const result = await OPERATIONS.messagesList(ctx, { channelId: GROUP_ID, source: 'live' });

    expect(iterHistory.mock.calls[0][0]).toBe(INPUT_PEER_CHAT);
    expect(result.messages).toHaveLength(1);
  });

  it('messagesGet source=live works with a positive group id', async () => {
    const getMessages = vi.fn().mockResolvedValue([{ id: 5, date: 1700000000, text: 'one' }]);
    const ctx = {
      telegramClient: makeTelegramClient({ getMessages }),
      messageSyncService: makeSyncService(),
    };

    const result = await OPERATIONS.messagesGet(ctx, {
      channelId: GROUP_ID,
      messageId: 5,
      source: 'live',
    });

    expect(getMessages).toHaveBeenCalledWith(INPUT_PEER_CHAT, 5);
    expect(result.message.messageId ?? result.message.id).toBeDefined();
  });

  it('messagesContext source=live works with a positive group id', async () => {
    const getMessages = vi.fn().mockResolvedValue([{ id: 5, date: 1700000000, text: 'target' }]);
    const getHistory = vi.fn().mockResolvedValue([
      { id: 4, date: 1699999999, text: 'before' },
      { id: 5, date: 1700000000, text: 'target' },
    ]);
    const ctx = {
      telegramClient: makeTelegramClient({ getMessages, getHistory }),
      messageSyncService: makeSyncService(),
    };

    const result = await OPERATIONS.messagesContext(ctx, {
      channelId: GROUP_ID,
      messageId: 5,
      source: 'live',
    });

    expect(getHistory.mock.calls[0][0]).toBe(INPUT_PEER_CHAT);
    expect(result.target).toBeTruthy();
  });

  it('mediaDownload works with a positive group id', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-peer-ops-'));
    try {
      const message = {
        id: 5,
        media: {
          type: 'document',
          mimeType: 'application/pdf',
          fileName: 'doc.pdf',
          location: { _: 'inputDocumentFileLocation' },
        },
      };
      const ctx = {
        telegramClient: makeTelegramClient({
          getMessages: vi.fn().mockResolvedValue([message]),
          downloadAsNodeStream: vi.fn(() => Readable.from([new Uint8Array([1, 2, 3])])),
        }),
        messageSyncService: makeSyncService(),
      };

      const result = await OPERATIONS.mediaDownload(ctx, {
        channelId: GROUP_ID,
        messageId: 5,
        outputPath: path.join(tmpDir, 'doc.pdf'),
      });

      expect(ctx.telegramClient.client.getMessages).toHaveBeenCalledWith(INPUT_PEER_CHAT, 5);
      expect(result.bytes).toBe(3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('channelShow falls back to live metadata with a positive group id', async () => {
    const getChat = vi.fn().mockResolvedValue({ displayName: 'Group', chatType: 'group' });
    const getFullChat = vi.fn().mockResolvedValue({ bio: 'about' });
    const ctx = {
      telegramClient: makeTelegramClient({ getChat, getFullChat }),
      messageSyncService: makeSyncService(),
    };

    const result = await OPERATIONS.channelShow(ctx, { chat: GROUP_ID });

    expect(getChat).toHaveBeenCalledWith(INPUT_PEER_CHAT);
    expect(result.peerTitle).toBe('Group');
    expect(result.source).toBe('live');
  });

  it('metadataGet falls back to live metadata with a positive group id', async () => {
    const getChat = vi.fn().mockResolvedValue({ displayName: 'Group', chatType: 'group' });
    const getFullChat = vi.fn().mockResolvedValue({ bio: 'about' });
    const ctx = {
      telegramClient: makeTelegramClient({ getChat, getFullChat }),
      messageSyncService: makeSyncService({ getChannelMetadata: vi.fn(() => null) }),
    };

    const result = await OPERATIONS.metadataGet(ctx, { chat: GROUP_ID });

    expect(result.peerTitle).toBe('Group');
    expect(result.source).toBe('live');
  });

  it('channelSetSync enable canonicalizes the chat key for every service call', async () => {
    const ctx = {
      telegramClient: makeTelegramClient(),
      messageSyncService: makeSyncService(),
    };

    const result = await OPERATIONS.channelSetSync(ctx, { chat: GROUP_ID, enable: true });

    expect(ctx.messageSyncService.setChannelSync).toHaveBeenCalledWith(CANONICAL_ID, true);
    expect(ctx.messageSyncService.listJobs).toHaveBeenCalledWith({ channelId: CANONICAL_ID, limit: 1 });
    expect(ctx.messageSyncService.addJob).toHaveBeenCalledWith(CANONICAL_ID);
    expect(result.channelId).toBe(CANONICAL_ID);
    expect(result.jobQueued).toBe(true);
  });

  it('channelSetSync disable uses archive-key disambiguation, never live resolution', async () => {
    const ctx = {
      telegramClient: makeTelegramClient(),
      messageSyncService: makeSyncService({
        resolveArchiveChannelKey: vi.fn(() => CANONICAL_ID),
        setChannelSync: vi.fn((id, enabled) => ({ channel_id: String(id), sync_enabled: enabled ? 1 : 0 })),
      }),
    };

    const result = await OPERATIONS.channelSetSync(ctx, { chat: GROUP_ID, enable: false });

    expect(ctx.messageSyncService.resolveArchiveChannelKey).toHaveBeenCalledWith(GROUP_ID);
    expect(ctx.messageSyncService.setChannelSync).toHaveBeenCalledWith(CANONICAL_ID, false);
    expect(ctx.telegramClient.client.resolvePeer).not.toHaveBeenCalled();
    expect(ctx.messageSyncService.addJob).not.toHaveBeenCalled();
    expect(result.syncEnabled).toBe(false);
  });
});
