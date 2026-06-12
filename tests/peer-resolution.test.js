// Unit tests for TelegramClient.resolveInputPeer / canonicalizeChannelId and
// the live read paths that must hand the *resolved peer object* (not the raw
// reference) to mtcute methods that re-resolve internally. Uses the real
// @mtcute/core module so MtPeerNotFoundError and toggleChannelIdMark behave
// exactly as in production.

import { describe, expect, it, vi } from 'vitest';
import { MtPeerNotFoundError, toggleChannelIdMark } from '@mtcute/core';

import TelegramClient from '../telegram-client.js';

const GROUP_ID = 4701666782;
const CHANNEL_FORM = toggleChannelIdMark(GROUP_ID); // -1004701666782
const CHAT_FORM = -GROUP_ID; // -4701666782

const INPUT_PEER_CHAT = { _: 'inputPeerChat', chatId: GROUP_ID };
const INPUT_PEER_CHANNEL = { _: 'inputPeerChannel', channelId: GROUP_ID, accessHash: 99 };

function notFound(ref) {
  return new MtPeerNotFoundError(`Peer ${ref} is not found in local cache`);
}

// Bare prototype instance with a fake mtcute inner client, mirroring the
// pattern in send-messages.test.js.
function makeClient(client = {}) {
  const tc = Object.create(TelegramClient.prototype);
  tc.ensureLogin = vi.fn().mockResolvedValue(undefined);
  tc.client = client;
  return tc;
}

// resolvePeer fake that rejects the positive and channel (-100...) forms with
// MtPeerNotFoundError and resolves the basic-chat (-id) form — the shape of a
// plain group chat addressed by its bare positive id.
function groupResolvePeer() {
  return vi.fn(async (ref) => {
    if (ref === CHAT_FORM) {
      return INPUT_PEER_CHAT;
    }
    throw notFound(ref);
  });
}

describe('resolveInputPeer', () => {
  it('resolves a positive user id directly with a single resolvePeer call', async () => {
    const peer = { _: 'inputPeerUser', userId: 42, accessHash: 7 };
    const tc = makeClient({ resolvePeer: vi.fn().mockResolvedValue(peer) });

    const result = await tc.resolveInputPeer('42');

    expect(result.peer).toBe(peer);
    expect(result.canonicalId).toBe('42');
    expect(tc.client.resolvePeer).toHaveBeenCalledTimes(1);
    expect(tc.client.resolvePeer).toHaveBeenCalledWith(42);
  });

  it('falls back from a positive group id to the chat form, channel form first', async () => {
    const tc = makeClient({ resolvePeer: groupResolvePeer() });

    const result = await tc.resolveInputPeer(String(GROUP_ID));

    expect(result.peer).toBe(INPUT_PEER_CHAT);
    expect(result.canonicalId).toBe(String(CHAT_FORM));
    expect(tc.client.resolvePeer.mock.calls.map(([ref]) => ref))
      .toEqual([GROUP_ID, CHANNEL_FORM, CHAT_FORM]);
  });

  it('resolves a positive supergroup id via the channel form without trying the chat form', async () => {
    const tc = makeClient({
      resolvePeer: vi.fn(async (ref) => {
        if (ref === CHANNEL_FORM) {
          return INPUT_PEER_CHANNEL;
        }
        throw notFound(ref);
      }),
    });

    const result = await tc.resolveInputPeer(GROUP_ID);

    expect(result.peer).toBe(INPUT_PEER_CHANNEL);
    expect(result.canonicalId).toBe(String(CHANNEL_FORM));
    expect(tc.client.resolvePeer.mock.calls.map(([ref]) => ref))
      .toEqual([GROUP_ID, CHANNEL_FORM]);
  });

  it('decorates an uncached marked channel id miss with a cache-seeding hint', async () => {
    const tc = makeClient({
      resolvePeer: vi.fn(async (ref) => {
        throw notFound(ref);
      }),
    });

    const promise = tc.resolveInputPeer(String(CHANNEL_FORM));
    await expect(promise).rejects.toThrow(/channels list/);
    await tc.resolveInputPeer(String(CHANNEL_FORM)).catch((error) => {
      // The original mtcute text is preserved ahead of the hint.
      expect(error.message).toContain(`Peer ${CHANNEL_FORM} is not found in local cache`);
    });
    // Negative refs get no sign fallback: one resolvePeer call per attempt.
    expect(tc.client.resolvePeer).toHaveBeenCalledTimes(2);
  });

  it('decorates a positive id miss with the negative-id workaround', async () => {
    const tc = makeClient({
      resolvePeer: vi.fn(async (ref) => {
        throw notFound(ref);
      }),
    });

    expect.assertions(4);
    await tc.resolveInputPeer(GROUP_ID).catch((error) => {
      expect(error).toBeInstanceOf(MtPeerNotFoundError);
      expect(error.message).toContain(`Peer ${GROUP_ID} is not found in local cache`);
      expect(error.message).toContain(`--chat="-${GROUP_ID}"`);
      expect(error.message).toContain('tgcli channels list');
    });
  });

  it('rethrows non-MtPeerNotFoundError failures unmodified, with no fallback attempts', async () => {
    const networkError = new Error('connection lost');
    const tc = makeClient({ resolvePeer: vi.fn().mockRejectedValue(networkError) });

    await expect(tc.resolveInputPeer(GROUP_ID)).rejects.toBe(networkError);
    expect(networkError.message).toBe('connection lost');
    expect(tc.client.resolvePeer).toHaveBeenCalledTimes(1);
  });

  it('rejects a display name before any network call', async () => {
    const tc = makeClient({ resolvePeer: vi.fn() });

    await expect(tc.resolveInputPeer('ИП Фастов К.Ю: Ольга Кожан'))
      .rejects.toThrow(/display name/);
    await expect(tc.resolveInputPeer('ИП Фастов К.Ю: Ольга Кожан'))
      .rejects.toThrow(/channels list --query/);
    expect(tc.client.resolvePeer).not.toHaveBeenCalled();
  });

  it('decorates a username miss with a title-vs-id hint', async () => {
    const tc = makeClient({
      resolvePeer: vi.fn(async () => {
        throw new MtPeerNotFoundError('Peer with username someuser was not found');
      }),
    });

    expect.assertions(3);
    await tc.resolveInputPeer('@someuser').catch((error) => {
      expect(error.message).toContain('Peer with username someuser was not found');
      expect(error.message).toContain('channels list --query');
    });
    expect(tc.client.resolvePeer).toHaveBeenCalledWith('@someuser');
  });

  it('returns a null canonicalId for inputPeerSelf', async () => {
    const tc = makeClient({ resolvePeer: vi.fn().mockResolvedValue({ _: 'inputPeerSelf' }) });

    const result = await tc.resolveInputPeer('me');

    expect(result.peer).toEqual({ _: 'inputPeerSelf' });
    expect(result.canonicalId).toBeNull();
  });
});

describe('canonicalizeChannelId', () => {
  it('passes usernames through without resolution', async () => {
    const tc = makeClient({ resolvePeer: vi.fn() });

    await expect(tc.canonicalizeChannelId('@someuser')).resolves.toBe('@someuser');
    expect(tc.client.resolvePeer).not.toHaveBeenCalled();
  });

  it("passes 'me' through unchanged", async () => {
    const tc = makeClient({ resolvePeer: vi.fn() });

    await expect(tc.canonicalizeChannelId('me')).resolves.toBe('me');
    expect(tc.client.resolvePeer).not.toHaveBeenCalled();
  });

  it('collapses a positive group id to the marked key the live writer uses', async () => {
    const tc = makeClient({ resolvePeer: groupResolvePeer() });

    await expect(tc.canonicalizeChannelId(String(GROUP_ID))).resolves.toBe(String(CHAT_FORM));
  });

  it('keeps a directly-resolvable positive id positive', async () => {
    const tc = makeClient({
      resolvePeer: vi.fn().mockResolvedValue({ _: 'inputPeerUser', userId: 42, accessHash: 7 }),
    });

    await expect(tc.canonicalizeChannelId('42')).resolves.toBe('42');
  });
});

describe('live read paths pass the resolved peer object onward', () => {
  function searchResults(messages = [{ id: 10, date: 1700000000, text: 'hit' }]) {
    const results = [...messages];
    results.total = messages.length;
    results.next = null;
    return results;
  }

  it('searchChannelMessages hands searchMessages the peer object for a positive group id', async () => {
    const searchMessages = vi.fn().mockResolvedValue(searchResults());
    const tc = makeClient({ resolvePeer: groupResolvePeer(), searchMessages });

    const result = await tc.searchChannelMessages(String(GROUP_ID), { query: 'hit' });

    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(searchMessages.mock.calls[0][0].chatId).toBe(INPUT_PEER_CHAT);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('hit');
  });

  it('getTopicMessages hands searchMessages the peer object', async () => {
    const searchMessages = vi.fn().mockResolvedValue(searchResults());
    const tc = makeClient({ resolvePeer: groupResolvePeer(), searchMessages });

    const result = await tc.getTopicMessages(String(GROUP_ID), 7, 50);

    expect(searchMessages.mock.calls[0][0].chatId).toBe(INPUT_PEER_CHAT);
    expect(searchMessages.mock.calls[0][0].threadId).toBe(7);
    expect(result.messages).toHaveLength(1);
  });

  it('getMessagesByChannelId iterates history with the peer object', async () => {
    const iterHistory = vi.fn(() => (async function* () {
      yield { id: 5, date: 1700000000, text: 'old' };
    })());
    const tc = makeClient({ resolvePeer: groupResolvePeer(), iterHistory });

    const result = await tc.getMessagesByChannelId(String(GROUP_ID), 10);

    expect(iterHistory.mock.calls[0][0]).toBe(INPUT_PEER_CHAT);
    expect(result.messages).toHaveLength(1);
  });

  it('getMessageById fetches via the peer object', async () => {
    const getMessages = vi.fn().mockResolvedValue([{ id: 5, date: 1700000000, text: 'one' }]);
    const tc = makeClient({ resolvePeer: groupResolvePeer(), getMessages });

    const message = await tc.getMessageById(String(GROUP_ID), 5);

    expect(getMessages).toHaveBeenCalledWith(INPUT_PEER_CHAT, 5);
    expect(message.id).toBe(5);
  });

  it('getMessageContext fetches target and history via the peer object', async () => {
    const getMessages = vi.fn().mockResolvedValue([{ id: 5, date: 1700000000, text: 'target' }]);
    const getHistory = vi.fn().mockResolvedValue([
      { id: 4, date: 1699999999, text: 'before' },
      { id: 5, date: 1700000000, text: 'target' },
      { id: 6, date: 1700000001, text: 'after' },
    ]);
    const tc = makeClient({ resolvePeer: groupResolvePeer(), getMessages, getHistory });

    const context = await tc.getMessageContext(String(GROUP_ID), 5, { before: 1, after: 1 });

    expect(getMessages).toHaveBeenCalledWith(INPUT_PEER_CHAT, 5);
    expect(getHistory.mock.calls[0][0]).toBe(INPUT_PEER_CHAT);
    expect(context.target.id).toBe(5);
    expect(context.before).toHaveLength(1);
    expect(context.after).toHaveLength(1);
  });

  it('downloadMessageMedia looks the message up via the peer object', async () => {
    const getMessages = vi.fn().mockResolvedValue([{ id: 5, date: 1700000000, media: null }]);
    const tc = makeClient({ resolvePeer: groupResolvePeer(), getMessages });

    // No media on the message: the relevant assertion is that the lookup got
    // past peer resolution and used the resolved peer object.
    await expect(tc.downloadMessageMedia(String(GROUP_ID), 5)).rejects.toThrow(/no downloadable media/);
    expect(getMessages).toHaveBeenCalledWith(INPUT_PEER_CHAT, 5);
  });

  it('getPeerMetadata resolves a positive group id and feeds the peer to chat lookups', async () => {
    const getChat = vi.fn().mockResolvedValue({ displayName: 'Group', chatType: 'group' });
    const getFullChat = vi.fn().mockResolvedValue({ bio: 'about' });
    const tc = makeClient({ resolvePeer: groupResolvePeer(), getChat, getFullChat });

    const metadata = await tc.getPeerMetadata(String(GROUP_ID));

    expect(getChat).toHaveBeenCalledWith(INPUT_PEER_CHAT);
    expect(getFullChat).toHaveBeenCalledWith(INPUT_PEER_CHAT);
    expect(metadata.peerTitle).toBe('Group');
    expect(metadata.about).toBe('about');
  });

  it('markChannelRead resolves through the sign fallback', async () => {
    const readHistory = vi.fn().mockResolvedValue(undefined);
    const tc = makeClient({ resolvePeer: groupResolvePeer(), readHistory });

    const result = await tc.markChannelRead(String(GROUP_ID), 9);

    expect(readHistory).toHaveBeenCalledWith(INPUT_PEER_CHAT, { maxId: 9 });
    expect(result.messageId).toBe(9);
  });
});
