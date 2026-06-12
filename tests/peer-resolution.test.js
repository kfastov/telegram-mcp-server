// Unit tests for TelegramClient.resolveInputPeer / canonicalizeChannelId and
// the live read paths that must hand the *resolved peer object* (not the raw
// reference) to mtcute methods that re-resolve internally. Uses the real
// @mtcute/core module so MtPeerNotFoundError and toggleChannelIdMark behave
// exactly as in production.

import { describe, expect, it, vi } from 'vitest';
import { MtPeerNotFoundError, tl, toggleChannelIdMark } from '@mtcute/core';

import TelegramClient from '../telegram-client.js';
import { PEER_SIGN_RETRY_PATTERN } from '../core/peer-hints.js';

const GROUP_ID = 4701666782;
const CHANNEL_FORM = toggleChannelIdMark(GROUP_ID); // -1004701666782
const CHAT_FORM = -GROUP_ID; // -4701666782

const INPUT_PEER_CHAT = { _: 'inputPeerChat', chatId: GROUP_ID };
const INPUT_PEER_CHANNEL = { _: 'inputPeerChannel', channelId: GROUP_ID, accessHash: 99 };

function notFound(ref) {
  return new MtPeerNotFoundError(`Peer ${ref} is not found in local cache`);
}

// Bare prototype instance with a fake mtcute inner client, mirroring the
// pattern in send-messages.test.js. Peer storage defaults to empty so the
// basic-chat existence probe takes the same path as a fresh session.
function makeClient(client = {}) {
  const tc = Object.create(TelegramClient.prototype);
  tc.ensureLogin = vi.fn().mockResolvedValue(undefined);
  tc.client = {
    storage: emptyPeerStorage(),
    ...client,
  };
  return tc;
}

function emptyPeerStorage() {
  return { peers: { getById: vi.fn(async () => null) } };
}

// Peer storage holding the basic chat, as after a dialog sync: the existence
// probe accepts the structurally-resolved chat without a getChat round-trip.
function cachedChatStorage() {
  return { peers: { getById: vi.fn(async (id) => (id === CHAT_FORM ? INPUT_PEER_CHAT : null)) } };
}

// resolvePeer fake mirroring real mtcute for a bare positive group id: the
// positive (user-marked) and channel (-100...) forms miss and throw, while the
// basic-chat (-id) form ALWAYS resolves structurally — real resolvePeer builds
// inputPeerChat without consulting cache or server and never throws for it.
// Whether the chat actually exists is decided by the existence probe (peer
// storage, then getChat), not by resolvePeer.
function groupResolvePeer() {
  return vi.fn(async (ref) => {
    if (ref === CHAT_FORM) {
      return INPUT_PEER_CHAT;
    }
    throw notFound(ref);
  });
}

// Inner-client fakes for a plain group the account is a member of, addressed
// by its bare positive id: structural chat-form resolution plus a storage hit
// in the existence probe.
function cachedGroupClient(extra = {}) {
  return { resolvePeer: groupResolvePeer(), storage: cachedChatStorage(), ...extra };
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
    const tc = makeClient(cachedGroupClient());

    const result = await tc.resolveInputPeer(String(GROUP_ID));

    expect(result.peer).toBe(INPUT_PEER_CHAT);
    expect(result.canonicalId).toBe(String(CHAT_FORM));
    expect(tc.client.resolvePeer.mock.calls.map(([ref]) => ref))
      .toEqual([GROUP_ID, CHANNEL_FORM, CHAT_FORM]);
    // The structural inputPeerChat was accepted via the storage probe.
    expect(tc.client.storage.peers.getById).toHaveBeenCalledWith(CHAT_FORM);
  });

  it('confirms an uncached basic chat with getChat before accepting the structural peer', async () => {
    const getChat = vi.fn().mockResolvedValue({ id: GROUP_ID, displayName: 'Group' });
    const tc = makeClient({ resolvePeer: groupResolvePeer(), getChat });

    const result = await tc.resolveInputPeer(GROUP_ID);

    expect(result.peer).toBe(INPUT_PEER_CHAT);
    expect(result.canonicalId).toBe(String(CHAT_FORM));
    expect(getChat).toHaveBeenCalledWith(INPUT_PEER_CHAT);
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
    await expect(promise).rejects.toThrow(/seed the local cache/);
    await tc.resolveInputPeer(String(CHANNEL_FORM)).catch((error) => {
      // The original mtcute text is preserved ahead of the hint.
      expect(error.message).toContain(`Peer ${CHANNEL_FORM} is not found in local cache`);
    });
    // Negative refs get no sign fallback: one resolvePeer call per attempt.
    expect(tc.client.resolvePeer).toHaveBeenCalledTimes(2);
  });

  it('decorates a positive id miss with the negative-id workaround', async () => {
    // Real failure shape for a nonexistent id (and for an uncached supergroup):
    // the positive and channel forms throw, the basic-chat form resolves
    // structurally, and the existence probe (storage miss, then getChat)
    // rejects it — the structural inputPeerChat must NOT be accepted.
    const getChat = vi.fn().mockRejectedValue(
      new MtPeerNotFoundError(`Chat ${GROUP_ID} was not found`),
    );
    const tc = makeClient({ resolvePeer: groupResolvePeer(), getChat });

    expect.assertions(7);
    await tc.resolveInputPeer(GROUP_ID).catch((error) => {
      expect(error).toBeInstanceOf(MtPeerNotFoundError);
      expect(error.message).toContain(`Peer ${GROUP_ID} is not found in local cache`);
      // The hint stays frontend-neutral (the client also backs the MCP server
      // and control API): no CLI flag syntax, and it matches the pattern the
      // CLI boundary uses to restate it in flag vocabulary.
      expect(error.message).not.toContain('--chat');
      expect(error.message).toContain(`retry with the negative id "-${GROUP_ID}"`);
      expect(PEER_SIGN_RETRY_PATTERN.exec(error.message)?.[1]).toBe(`-${GROUP_ID}`);
    });
    expect(tc.client.resolvePeer.mock.calls.map(([ref]) => ref))
      .toEqual([GROUP_ID, CHANNEL_FORM, CHAT_FORM]);
    expect(getChat).toHaveBeenCalledWith(INPUT_PEER_CHAT);
  });

  it('treats a Telegram id rejection in the probe as a miss', async () => {
    const getChat = vi.fn().mockRejectedValue(new tl.RpcError(400, 'CHAT_ID_INVALID'));
    const tc = makeClient({ resolvePeer: groupResolvePeer(), getChat });

    await expect(tc.resolveInputPeer(GROUP_ID))
      .rejects.toThrow(/retry with the negative id/);
  });

  it('propagates unexpected probe failures instead of swallowing them', async () => {
    const networkError = new Error('connection lost');
    const getChat = vi.fn().mockRejectedValue(networkError);
    const tc = makeClient({ resolvePeer: groupResolvePeer(), getChat });

    await expect(tc.resolveInputPeer(GROUP_ID)).rejects.toBe(networkError);
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
      .rejects.toThrow(/search the chat list/);
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
      expect(error.message).toContain('search the chat list');
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
    const tc = makeClient(cachedGroupClient());

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
    const tc = makeClient(cachedGroupClient({ searchMessages }));

    const result = await tc.searchChannelMessages(String(GROUP_ID), { query: 'hit' });

    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(searchMessages.mock.calls[0][0].chatId).toBe(INPUT_PEER_CHAT);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('hit');
  });

  it('getTopicMessages hands searchMessages the peer object', async () => {
    const searchMessages = vi.fn().mockResolvedValue(searchResults());
    const tc = makeClient(cachedGroupClient({ searchMessages }));

    const result = await tc.getTopicMessages(String(GROUP_ID), 7, 50);

    expect(searchMessages.mock.calls[0][0].chatId).toBe(INPUT_PEER_CHAT);
    expect(searchMessages.mock.calls[0][0].threadId).toBe(7);
    expect(result.messages).toHaveLength(1);
  });

  it('getMessagesByChannelId iterates history with the peer object', async () => {
    const iterHistory = vi.fn(() => (async function* () {
      yield { id: 5, date: 1700000000, text: 'old' };
    })());
    const tc = makeClient(cachedGroupClient({ iterHistory }));

    const result = await tc.getMessagesByChannelId(String(GROUP_ID), 10);

    expect(iterHistory.mock.calls[0][0]).toBe(INPUT_PEER_CHAT);
    expect(result.messages).toHaveLength(1);
  });

  it('getMessageById fetches via the peer object', async () => {
    const getMessages = vi.fn().mockResolvedValue([{ id: 5, date: 1700000000, text: 'one' }]);
    const tc = makeClient(cachedGroupClient({ getMessages }));

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
    const tc = makeClient(cachedGroupClient({ getMessages, getHistory }));

    const context = await tc.getMessageContext(String(GROUP_ID), 5, { before: 1, after: 1 });

    expect(getMessages).toHaveBeenCalledWith(INPUT_PEER_CHAT, 5);
    expect(getHistory.mock.calls[0][0]).toBe(INPUT_PEER_CHAT);
    expect(context.target.id).toBe(5);
    expect(context.before).toHaveLength(1);
    expect(context.after).toHaveLength(1);
  });

  it('downloadMessageMedia looks the message up via the peer object', async () => {
    const getMessages = vi.fn().mockResolvedValue([{ id: 5, date: 1700000000, media: null }]);
    const tc = makeClient(cachedGroupClient({ getMessages }));

    // No media on the message: the relevant assertion is that the lookup got
    // past peer resolution and used the resolved peer object.
    await expect(tc.downloadMessageMedia(String(GROUP_ID), 5)).rejects.toThrow(/no downloadable media/);
    expect(getMessages).toHaveBeenCalledWith(INPUT_PEER_CHAT, 5);
  });

  it('getPeerMetadata resolves a positive group id and feeds the peer to chat lookups', async () => {
    const getChat = vi.fn().mockResolvedValue({ displayName: 'Group', chatType: 'group' });
    const getFullChat = vi.fn().mockResolvedValue({ bio: 'about' });
    const tc = makeClient(cachedGroupClient({ getChat, getFullChat }));

    const metadata = await tc.getPeerMetadata(String(GROUP_ID));

    expect(getChat).toHaveBeenCalledWith(INPUT_PEER_CHAT);
    expect(getFullChat).toHaveBeenCalledWith(INPUT_PEER_CHAT);
    expect(metadata.peerTitle).toBe('Group');
    expect(metadata.about).toBe('about');
  });

  it('markChannelRead resolves through the sign fallback', async () => {
    const readHistory = vi.fn().mockResolvedValue(undefined);
    const tc = makeClient(cachedGroupClient({ readHistory }));

    const result = await tc.markChannelRead(String(GROUP_ID), 9);

    expect(readHistory).toHaveBeenCalledWith(INPUT_PEER_CHAT, { maxId: 9 });
    expect(result.messageId).toBe(9);
  });
});

describe('send and group-management paths resolve through the sign fallback', () => {
  it('sendTextMessage sends to the resolved peer for a positive group id', async () => {
    const sendText = vi.fn().mockResolvedValue({ id: 11 });
    const tc = makeClient(cachedGroupClient({ sendText }));

    const result = await tc.sendTextMessage(String(GROUP_ID), 'hello');

    expect(sendText).toHaveBeenCalledWith(INPUT_PEER_CHAT, 'hello', undefined);
    expect(result.messageId).toBe(11);
  });

  it('sendTextMessage surfaces the hinted resolution error for a dead positive id', async () => {
    const sendText = vi.fn();
    const getChat = vi.fn().mockRejectedValue(
      new MtPeerNotFoundError(`Chat ${GROUP_ID} was not found`),
    );
    const tc = makeClient({ resolvePeer: groupResolvePeer(), getChat, sendText });

    await expect(tc.sendTextMessage(String(GROUP_ID), 'hello'))
      .rejects.toThrow(/retry with the negative id/);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('renameGroup and invite-link calls hand mtcute the resolved peer', async () => {
    const setChatTitle = vi.fn().mockResolvedValue(undefined);
    const getPrimaryInviteLink = vi.fn().mockResolvedValue({ link: 'https://t.me/+x' });
    const tc = makeClient(cachedGroupClient({ setChatTitle, getPrimaryInviteLink }));

    await tc.renameGroup(String(GROUP_ID), 'New title');
    await tc.getGroupInviteLink(String(GROUP_ID));

    expect(setChatTitle).toHaveBeenCalledWith(INPUT_PEER_CHAT, 'New title');
    expect(getPrimaryInviteLink).toHaveBeenCalledWith(INPUT_PEER_CHAT);
  });

  it('addGroupMembers passes the resolved peer to addChatMembers', async () => {
    const addChatMembers = vi.fn().mockResolvedValue([]);
    const tc = makeClient(cachedGroupClient({ addChatMembers }));

    await tc.addGroupMembers(String(GROUP_ID), ['@user1']);

    expect(addChatMembers).toHaveBeenCalledWith(INPUT_PEER_CHAT, ['@user1']);
  });
});
