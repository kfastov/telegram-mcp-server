// Shared operation handlers: the single source of truth for every Telegram and
// archive operation the CLI commands and the MCP tools perform. Each handler is
// `async (ctx, args) => result`, a function of the warm services it needs plus
// its args, returning the structured data a caller renders.
//
// ctx is the warm service bundle the control server owns:
// { telegramClient, messageSyncService }. Handlers may use either service;
// `messages` ops honor `source: archive|live|both`. The same handler backs both
// the CLI (via runOperation -> /control/invoke) and the MCP tools, so one
// implementation serves both surfaces with no duplicated logic.
//
// OPERATIONS is a fixed allowlist: the control server dispatches only the keys
// present here.

import {
  buildSendSuccessPayload,
  executeSendWithRetries,
  SendCommandError,
} from './send-utils.js';

// --- shared helpers ---

function resolveSource(source) {
  const resolved = source ? String(source).toLowerCase() : 'archive';
  if (!['archive', 'live', 'both'].includes(resolved)) {
    throw new Error(`Invalid source: ${source}`);
  }
  return resolved;
}

// Resolve a single result (a message or a context bundle) from one source,
// shared by the message ops that return one item. fetchLive/fetchArchive each
// return the formatted result or null when absent; the whole result comes from a
// single source so live and archive data never mix:
//   live  -> live only
//   both  -> live first, then archive
//   archive -> archive first, then live as a fallback (flags usedLiveFallback)
// Returns { result, source, usedLiveFallback }, or null when nothing is found.
async function resolveFromSource({ source, fetchLive, fetchArchive }) {
  let result = null;
  let resolvedFrom = null;
  let usedLiveFallback = false;

  if (source === 'live' || source === 'both') {
    result = await fetchLive();
    if (result) {
      resolvedFrom = 'live';
    }
  }

  if (!result && (source === 'archive' || source === 'both')) {
    result = await fetchArchive();
    if (result) {
      resolvedFrom = 'archive';
    }
  }

  if (!result && source === 'archive') {
    result = await fetchLive();
    if (result) {
      resolvedFrom = 'live';
      usedLiveFallback = true;
    }
  }

  if (!result) {
    return null;
  }
  return { result, source: resolvedFrom ?? source, usedLiveFallback };
}

function parseDateMs(value, label) {
  if (!value) {
    return null;
  }
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return ts;
}

function filterLiveMessagesByDate(messages, fromDate, toDate) {
  const fromMs = parseDateMs(fromDate, 'after');
  const toMs = parseDateMs(toDate, 'before');
  if (!fromMs && !toMs) {
    return messages;
  }
  return messages.filter((message) => {
    const ts = typeof message.date === 'number' ? message.date * 1000 : null;
    if (!ts) {
      return false;
    }
    if (fromMs && ts < fromMs) {
      return false;
    }
    if (toMs && ts > toMs) {
      return false;
    }
    return true;
  });
}

function getMessageIdValue(message) {
  const value = message?.messageId ?? message?.id;
  return Number.isFinite(value) ? value : null;
}

function filterMessagesById(messages, beforeId, afterId) {
  if (!beforeId && !afterId) {
    return messages;
  }
  return messages.filter((message) => {
    const messageId = getMessageIdValue(message);
    if (!messageId) {
      return false;
    }
    if (beforeId && messageId >= beforeId) {
      return false;
    }
    if (afterId && messageId <= afterId) {
      return false;
    }
    return true;
  });
}

function formatLiveMessage(message, context) {
  const dateIso = message.date ? new Date(message.date * 1000).toISOString() : null;
  return {
    channelId: context.channelId ?? message.peer_id ?? null,
    peerTitle: context.peerTitle ?? null,
    username: context.username ?? null,
    messageId: message.id,
    date: dateIso,
    fromId: message.from_id ?? null,
    fromUsername: message.from_username ?? null,
    fromDisplayName: message.from_display_name ?? null,
    fromPeerType: message.from_peer_type ?? null,
    fromIsBot: typeof message.from_is_bot === 'boolean' ? message.from_is_bot : null,
    text: message.text ?? message.message ?? '',
    urls: message.urls ?? null,
    media: message.media ?? null,
    topicId: message.topic_id ?? null,
  };
}

function messageDateMs(message) {
  const ts = Date.parse(message.date ?? '');
  return Number.isNaN(ts) ? 0 : ts;
}

function mergeMessageSets(sets, limit) {
  const map = new Map();
  for (const list of sets) {
    for (const message of list) {
      const channelId = message.channelId ?? '';
      const messageId = message.messageId ?? message.id;
      const key = `${String(channelId)}:${String(messageId)}`;
      if (!map.has(key) || message.source === 'live') {
        map.set(key, message);
      }
    }
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => messageDateMs(b) - messageDateMs(a));
  return limit && limit > 0 ? merged.slice(0, limit) : merged;
}

// Pick the final message set and the source label it reports, shared by the
// list/search ops. A 'both' request merges the two sets; otherwise the result is
// drawn from a single source so live and archive rows never mix. An archive
// request that fell back to live reports 'live'. Returns { messages, source }.
function selectMessageResults({ source, archivedResults, liveResults, usedLiveFallback, limit }) {
  if (source === 'both') {
    return { messages: mergeMessageSets([archivedResults, liveResults], limit), source };
  }
  if (source === 'live' || usedLiveFallback) {
    return { messages: liveResults, source: 'live' };
  }
  return { messages: archivedResults, source };
}

function buildMessageListPayload(source, messages, requestedLimit) {
  const hasMore = requestedLimit ? messages.length === requestedLimit : false;
  const payload = {
    source,
    returned: messages.length,
    hasMore,
    messages,
  };
  if (hasMore) {
    const nextBeforeId = getMessageIdValue(messages[messages.length - 1]);
    if (nextBeforeId) {
      payload.nextBeforeId = nextBeforeId;
    }
  }
  return payload;
}

function normalizeChannelIds(value) {
  if (Array.isArray(value)) {
    return value.filter((id) => id !== null && id !== undefined && String(id).trim() !== '');
  }
  if (value === null || value === undefined || String(value).trim() === '') {
    return [];
  }
  return [value];
}

// Resolve peerTitle/username for a channel, preferring cached metadata and
// falling back to a live peer lookup so live-formatted messages carry a label.
async function resolveLiveMetadata(ctx, channelId, fallback = {}) {
  const meta = ctx.messageSyncService.getChannelMetadata(channelId);
  let peerTitle = meta?.peerTitle ?? fallback.peerTitle ?? null;
  let username = meta?.username ?? fallback.username ?? null;
  if (!peerTitle || !username) {
    const live = await ctx.telegramClient.getPeerMetadata(channelId);
    peerTitle = peerTitle ?? live?.peerTitle ?? null;
    username = username ?? live?.username ?? null;
  }
  return { peerTitle, username };
}

// --- channels ---

// args: { query?, limit? }. With a query, search dialogs; otherwise list them.
async function listChannels(ctx, args = {}) {
  const limit = args.limit ?? 50;
  if (args.query) {
    return ctx.telegramClient.searchDialogs(args.query, limit);
  }
  return ctx.telegramClient.listDialogs(limit);
}

// args: { chat }. Returns the archive channel record, or a live-metadata-derived
// record when the chat is not tracked in the archive.
async function channelShow(ctx, args = {}) {
  let channel = ctx.messageSyncService.getChannel(args.chat);
  if (channel) {
    return channel;
  }
  const meta = await ctx.telegramClient.getPeerMetadata(args.chat);
  return {
    channelId: String(args.chat),
    peerTitle: meta?.peerTitle ?? null,
    peerType: meta?.peerType ?? null,
    chatType: meta?.chatType ?? null,
    isForum: meta?.isForum ?? null,
    username: meta?.username ?? null,
    syncEnabled: null,
    lastMessageId: null,
    lastMessageDate: null,
    oldestMessageId: null,
    oldestMessageDate: null,
    about: meta?.about ?? null,
    metadataUpdatedAt: null,
    createdAt: null,
    updatedAt: null,
    source: 'live',
  };
}

// args: { chat, enable }. Toggle the per-chat archive flag; enabling also queues
// a backfill job when none exists. Returns the new sync state plus job info.
async function channelSetSync(ctx, args = {}) {
  const result = ctx.messageSyncService.setChannelSync(args.chat, Boolean(args.enable));
  let job = null;
  let jobQueued = false;
  if (args.enable) {
    const existing = ctx.messageSyncService.listJobs({ channelId: args.chat, limit: 1 });
    if (existing.length > 0) {
      job = existing[0];
    } else {
      job = ctx.messageSyncService.addJob(args.chat);
      jobQueued = true;
      void ctx.messageSyncService.processQueue();
    }
  }
  return {
    channelId: result.channel_id,
    syncEnabled: Boolean(result.sync_enabled),
    jobId: job?.id ?? null,
    jobStatus: job?.status ?? null,
    jobQueued,
  };
}

// --- messages ---

async function fetchLiveMessagesForChannel(ctx, id, options = {}) {
  const { query, topicId, limit, beforeId, afterId } = options;
  let peerTitle = null;
  let username = null;
  let liveMessages = [];

  if (query) {
    const response = await ctx.telegramClient.searchChannelMessages(id, {
      query,
      limit,
      topicId,
      beforeId,
      afterId,
    });
    liveMessages = response.messages;
    peerTitle = response.peerTitle ?? null;
  } else if (topicId) {
    const response = await ctx.telegramClient.getTopicMessages(id, topicId, limit, {
      beforeId,
      afterId,
    });
    liveMessages = response.messages;
  } else {
    const fetchOptions = {};
    if (beforeId) fetchOptions.beforeId = beforeId;
    if (afterId) fetchOptions.afterId = afterId;
    const response = await ctx.telegramClient.getMessagesByChannelId(id, limit, fetchOptions);
    liveMessages = response.messages;
    peerTitle = response.peerTitle ?? null;
  }

  const meta = await resolveLiveMetadata(ctx, id, { peerTitle, username });
  return { messages: liveMessages, peerTitle: meta.peerTitle, username: meta.username };
}

// args: { channelIds?, topicId?, source?, fromDate?, toDate?, beforeId?, afterId?,
// limit? }. Lists messages from the archive and/or live API. With source 'archive'
// and no archived rows, falls back to live and flags usedLiveFallback so callers
// can hint the user. Returns a list payload plus { usedLiveFallback }.
async function messagesList(ctx, args = {}) {
  const resolvedSource = resolveSource(args.source);
  const channelIds = normalizeChannelIds(args.channelIds ?? args.channelId);
  const topicId = args.topicId ?? null;
  const limit = args.limit ?? 50;
  const beforeId = args.beforeId ?? null;
  const afterId = args.afterId ?? null;

  let archivedResults = [];
  let liveResults = [];
  let usedLiveFallback = false;

  const fetchLive = async (liveChannelIds) => {
    const results = [];
    for (const id of liveChannelIds) {
      const fetched = await fetchLiveMessagesForChannel(ctx, id, {
        topicId,
        limit,
        beforeId,
        afterId,
      });
      const filtered = filterMessagesById(
        filterLiveMessagesByDate(fetched.messages, args.fromDate, args.toDate),
        beforeId,
        afterId,
      );
      results.push(...filtered.map((message) => ({
        ...formatLiveMessage(message, {
          channelId: String(id),
          peerTitle: fetched.peerTitle,
          username: fetched.username,
        }),
        source: 'live',
      })));
    }
    return results;
  };

  if (resolvedSource === 'archive' || resolvedSource === 'both') {
    const archived = ctx.messageSyncService.listArchivedMessages({
      channelIds: channelIds.length ? channelIds : null,
      topicId,
      fromDate: args.fromDate,
      toDate: args.toDate,
      beforeId,
      afterId,
      limit,
    });
    archivedResults = archived.map((message) => ({ ...message, source: 'archive' }));
  }

  if (resolvedSource === 'live' || resolvedSource === 'both') {
    if (!channelIds.length) {
      throw new Error('--chat is required for live source.');
    }
    liveResults = await fetchLive(channelIds);
  }

  if (resolvedSource === 'archive' && archivedResults.length === 0 && channelIds.length) {
    liveResults = await fetchLive(channelIds);
    usedLiveFallback = true;
  }

  const { messages, source: outputSource } = selectMessageResults({
    source: resolvedSource,
    archivedResults,
    liveResults,
    usedLiveFallback,
    limit,
  });

  return { ...buildMessageListPayload(outputSource, messages, limit), usedLiveFallback };
}

// args: { query?, regex?, source?, channelIds?, tags?, topicId?, fromDate?,
// toDate?, beforeId?, afterId?, limit?, caseInsensitive? }. Searches archive and/or
// live. Falls back to live when archive search is empty. Returns
// { source, returned, messages, usedLiveFallback }.
async function messagesSearch(ctx, args = {}) {
  const resolvedSource = resolveSource(args.source);
  const channelIds = normalizeChannelIds(args.channelIds ?? args.channelId);
  const tagList = normalizeChannelIds(args.tags ?? args.tag);
  const topicId = args.topicId ?? null;
  const limit = args.limit ?? 100;
  const beforeId = args.beforeId ?? null;
  const afterId = args.afterId ?? null;
  const caseInsensitive = args.caseInsensitive !== false;
  const query = args.query;

  if (!query && !args.regex && tagList.length === 0) {
    throw new Error('Provide query, regex, or tag for messages search.');
  }

  let archivedResults = [];
  let liveResults = [];
  let usedLiveFallback = false;

  const buildLiveChannelIds = () => {
    let liveChannelIds = channelIds;
    if (!liveChannelIds.length && tagList.length) {
      const tagged = new Map();
      for (const tag of tagList) {
        const channels = ctx.messageSyncService.listTaggedChannels(tag, { limit: 200 });
        for (const channel of channels) {
          tagged.set(channel.channelId, channel);
        }
      }
      liveChannelIds = Array.from(tagged.keys());
    }
    return liveChannelIds;
  };

  const fetchLive = async (liveChannelIds) => {
    let liveRegex = null;
    if (args.regex) {
      try {
        liveRegex = new RegExp(args.regex, caseInsensitive ? 'i' : '');
      } catch (error) {
        throw new Error(`Invalid regex: ${error.message}`);
      }
    }
    const results = [];
    for (const id of liveChannelIds) {
      const fetched = await fetchLiveMessagesForChannel(ctx, id, {
        query,
        topicId,
        limit,
        beforeId,
        afterId,
      });
      let filtered = filterLiveMessagesByDate(fetched.messages, args.fromDate, args.toDate);
      filtered = filterMessagesById(filtered, beforeId, afterId);
      if (liveRegex) {
        filtered = filtered.filter((message) =>
          liveRegex.test(message.text ?? message.message ?? ''),
        );
      }
      results.push(...filtered.map((message) => ({
        ...formatLiveMessage(message, {
          channelId: String(id),
          peerTitle: fetched.peerTitle,
          username: fetched.username,
        }),
        source: 'live',
      })));
    }
    return results;
  };

  if (resolvedSource === 'archive' || resolvedSource === 'both') {
    const archived = ctx.messageSyncService.searchArchiveMessages({
      query,
      regex: args.regex,
      tags: tagList.length ? tagList : null,
      channelIds: channelIds.length ? channelIds : null,
      topicId,
      fromDate: args.fromDate,
      toDate: args.toDate,
      beforeId,
      afterId,
      limit,
      caseInsensitive,
    });
    archivedResults = archived.map((message) => ({ ...message, source: 'archive' }));
  }

  if (resolvedSource === 'live' || resolvedSource === 'both') {
    const liveChannelIds = buildLiveChannelIds();
    if (!liveChannelIds.length) {
      throw new Error('--chat is required for live search.');
    }
    liveResults = await fetchLive(liveChannelIds);
  }

  if (resolvedSource === 'archive' && archivedResults.length === 0) {
    const liveChannelIds = buildLiveChannelIds();
    if (liveChannelIds.length) {
      liveResults = await fetchLive(liveChannelIds);
      usedLiveFallback = true;
    }
  }

  const { messages, source: outputSource } = selectMessageResults({
    source: resolvedSource,
    archivedResults,
    liveResults,
    usedLiveFallback,
    limit,
  });

  return { source: outputSource, returned: messages.length, messages, usedLiveFallback };
}

// args: { channelId, messageId, source? }. Returns { source, message, usedLiveFallback }.
async function messagesGet(ctx, args = {}) {
  const resolvedSource = resolveSource(args.source);
  const channelId = args.channelId;
  const messageId = args.messageId;

  const fetchLive = async () => {
    const live = await ctx.telegramClient.getMessageById(channelId, messageId);
    if (!live) {
      return null;
    }
    const meta = await resolveLiveMetadata(ctx, channelId);
    return {
      ...formatLiveMessage(live, { channelId: String(channelId), ...meta }),
      source: 'live',
    };
  };

  const fetchArchive = async () => {
    const archived = ctx.messageSyncService.getArchivedMessage({ channelId, messageId });
    return archived ? { ...archived, source: 'archive' } : null;
  };

  const resolved = await resolveFromSource({ source: resolvedSource, fetchLive, fetchArchive });
  if (!resolved) {
    throw new Error('Message not found.');
  }

  return { source: resolved.source, message: resolved.result, usedLiveFallback: resolved.usedLiveFallback };
}

// args: { channelId, messageId, before?, after?, source? }.
// Returns { source, target, before, after, usedLiveFallback }.
async function messagesContext(ctx, args = {}) {
  const resolvedSource = resolveSource(args.source);
  const channelId = args.channelId;
  const messageId = args.messageId;
  const safeBefore = Number.isFinite(args.before) ? args.before : 20;
  const safeAfter = Number.isFinite(args.after) ? args.after : 20;

  const fetchLive = async () => {
    const liveContext = await ctx.telegramClient.getMessageContext(channelId, messageId, {
      before: safeBefore,
      after: safeAfter,
    });
    if (!liveContext.target) {
      return null;
    }
    const meta = await resolveLiveMetadata(ctx, channelId);
    const toLive = (message) => ({
      ...formatLiveMessage(message, { channelId: String(channelId), ...meta }),
      source: 'live',
    });
    return {
      target: toLive(liveContext.target),
      before: liveContext.before.map(toLive),
      after: liveContext.after.map(toLive),
    };
  };

  const fetchArchive = async () => {
    const archiveContext = ctx.messageSyncService.getArchivedMessageContext({
      channelId,
      messageId,
      before: safeBefore,
      after: safeAfter,
    });
    if (!archiveContext.target) {
      return null;
    }
    return {
      target: { ...archiveContext.target, source: 'archive' },
      before: archiveContext.before.map((message) => ({ ...message, source: 'archive' })),
      after: archiveContext.after.map((message) => ({ ...message, source: 'archive' })),
    };
  };

  const resolved = await resolveFromSource({ source: resolvedSource, fetchLive, fetchArchive });
  if (!resolved) {
    throw new Error('Message not found.');
  }

  return { source: resolved.source, ...resolved.result, usedLiveFallback: resolved.usedLiveFallback };
}

// --- send ---

// Shared send executor: runs the existing send-utils retry/flood/timeout logic
// against the warm client. `sendFn` performs one send attempt; on exhausted
// retries this throws a SendCommandError carrying structured details, which the
// control server serializes and the CLI reconstructs.
async function runSend(sendFn, { method, retries, retryBackoff, timeoutMs }) {
  return executeSendWithRetries(sendFn, {
    method,
    retries,
    retryBackoff,
    timeoutMs,
  });
}

// args: { chat, text, parseMode?, topicId?, replyToMessageId?, noPreview?, silent?,
// noforwards?, scheduleDate?, retries?, retryBackoff?, timeoutMs? }.
// Returns { result, attempts }.
async function sendText(ctx, args = {}) {
  return runSend(
    () => ctx.telegramClient.sendTextMessage(args.chat, args.text, {
      topicId: args.topicId,
      replyToMessageId: args.replyToMessageId,
      parseMode: args.parseMode,
      noPreview: args.noPreview,
      silent: args.silent || false,
      noforwards: args.noforwards || false,
      scheduleDate: args.scheduleDate,
    }),
    { method: 'sendText', retries: args.retries, retryBackoff: args.retryBackoff, timeoutMs: args.timeoutMs },
  );
}

// args: like sendText plus { photo, caption?, captionAbove?, spoiler? }.
// Returns { result, attempts }.
async function sendPhoto(ctx, args = {}) {
  const prepared = await ctx.telegramClient.preparePhotoMessage(args.chat, args.photo, {
    caption: args.caption,
    topicId: args.topicId,
    replyToMessageId: args.replyToMessageId,
    parseMode: args.parseMode,
    silent: args.silent || false,
    noforwards: args.noforwards || false,
    captionAbove: args.captionAbove || false,
    spoiler: args.spoiler || false,
    scheduleDate: args.scheduleDate,
  });
  return runSend(
    () => ctx.telegramClient.sendPreparedPhotoMessage(prepared),
    { method: 'sendPhoto', retries: args.retries, retryBackoff: args.retryBackoff, timeoutMs: args.timeoutMs },
  );
}

// args: like sendText plus { file, caption?, filename?, captionAbove?, spoiler?,
// forceDocument? }. Returns { result, attempts }.
async function sendFile(ctx, args = {}) {
  return runSend(
    () => ctx.telegramClient.sendFileMessage(args.chat, args.file, {
      caption: args.caption,
      filename: args.filename,
      topicId: args.topicId,
      replyToMessageId: args.replyToMessageId,
      parseMode: args.parseMode,
      silent: args.silent || false,
      noforwards: args.noforwards || false,
      captionAbove: args.captionAbove || false,
      spoiler: args.spoiler || false,
      scheduleDate: args.scheduleDate,
      forceDocument: args.forceDocument || false,
    }),
    { method: 'sendFile', retries: args.retries, retryBackoff: args.retryBackoff, timeoutMs: args.timeoutMs },
  );
}

// --- topics ---

// args: { channelId, query?, limit? }. Lists/searches forum topics and refreshes
// the archive topic cache. Returns { total, topics }.
async function topicsList(ctx, args = {}) {
  const limit = args.limit ?? 100;
  const listOptions = { limit };
  if (args.query) {
    listOptions.query = args.query;
  }
  const topics = await ctx.telegramClient.listForumTopics(args.channelId, listOptions);
  ctx.messageSyncService.upsertTopics(args.channelId, topics);
  return { total: topics.total ?? topics.length, topics };
}

// --- tags ---

// args: { chat, tags, source? }. Returns the channel's tags after the set.
async function tagsSet(ctx, args = {}) {
  const finalTags = ctx.messageSyncService.setChannelTags(args.chat, args.tags, {
    source: args.source,
  });
  return { channelId: args.chat, tags: finalTags };
}

// args: { channelIds?, limit?, source?, refreshMetadata? }. Auto-tags channels.
async function tagsAuto(ctx, args = {}) {
  const channelIds = normalizeChannelIds(args.channelIds ?? args.channelId);
  const limit = args.limit ?? 50;
  return ctx.messageSyncService.autoTagChannels({
    channelIds: channelIds.length ? channelIds : null,
    limit,
    source: args.source,
    refreshMetadata: args.refreshMetadata !== false,
  });
}

// --- metadata ---

// args: { chat }. Returns cached channel metadata, falling back to a live lookup.
async function metadataGet(ctx, args = {}) {
  const metadata = ctx.messageSyncService.getChannelMetadata(args.chat);
  if (metadata) {
    return metadata;
  }
  const live = await ctx.telegramClient.getPeerMetadata(args.chat);
  return {
    channelId: String(args.chat),
    peerTitle: live?.peerTitle ?? null,
    peerType: live?.peerType ?? null,
    chatType: live?.chatType ?? null,
    isForum: live?.isForum ?? null,
    username: live?.username ?? null,
    about: live?.about ?? null,
    metadataUpdatedAt: null,
    source: 'live',
  };
}

// args: { channelIds?, limit?, force?, onlyMissing? }. Refreshes cached metadata.
async function metadataRefresh(ctx, args = {}) {
  const channelIds = normalizeChannelIds(args.channelIds ?? args.channelId);
  const limit = args.limit ?? 20;
  return ctx.messageSyncService.refreshChannelMetadata({
    channelIds: channelIds.length ? channelIds : null,
    limit,
    force: Boolean(args.force),
    onlyMissing: Boolean(args.onlyMissing),
  });
}

// --- contacts ---

// args: { query, limit? }. Refreshes contacts then searches them.
async function contactsSearch(ctx, args = {}) {
  await ctx.messageSyncService.refreshContacts();
  return ctx.messageSyncService.searchContacts(args.query, {
    limit: args.limit ?? 50,
  });
}

// args: { userId }. Returns a contact, refreshing from the network when missing.
async function contactsShow(ctx, args = {}) {
  let contact = ctx.messageSyncService.getContact(args.userId);
  if (!contact) {
    await ctx.messageSyncService.refreshContacts();
    contact = ctx.messageSyncService.getContact(args.userId);
  }
  if (!contact) {
    throw new Error('Contact not found.');
  }
  return contact;
}

// args: { userId, alias }. Sets a contact alias.
async function contactsAliasSet(ctx, args = {}) {
  const alias = ctx.messageSyncService.setContactAlias(args.userId, args.alias);
  return { userId: args.userId, alias };
}

// args: { userId }. Removes a contact alias.
async function contactsAliasRemove(ctx, args = {}) {
  ctx.messageSyncService.removeContactAlias(args.userId);
  return { userId: args.userId, removed: true };
}

// args: { userId, tags }. Adds contact tags, returning the updated set.
async function contactsTagsAdd(ctx, args = {}) {
  const tags = ctx.messageSyncService.addContactTags(args.userId, args.tags);
  return { userId: args.userId, tags };
}

// args: { userId, tags }. Removes contact tags, returning the updated set.
async function contactsTagsRemove(ctx, args = {}) {
  const tags = ctx.messageSyncService.removeContactTags(args.userId, args.tags);
  return { userId: args.userId, tags };
}

// args: { userId, notes }. Sets contact notes.
async function contactsNotesSet(ctx, args = {}) {
  const notes = ctx.messageSyncService.setContactNotes(args.userId, args.notes);
  return { userId: args.userId, notes };
}

// --- groups ---

// args: { chat, name }. Renames a group.
async function groupsRename(ctx, args = {}) {
  await ctx.telegramClient.renameGroup(args.chat, args.name);
  return { channelId: args.chat, name: args.name };
}

// args: { chat, userIds }. Adds members; returns { failed }.
async function groupMembersAdd(ctx, args = {}) {
  const failed = await ctx.telegramClient.addGroupMembers(args.chat, args.userIds);
  return { channelId: args.chat, failed };
}

// args: { chat, userIds }. Removes members; returns { removed, failed }.
async function groupMembersRemove(ctx, args = {}) {
  const result = await ctx.telegramClient.removeGroupMembers(args.chat, args.userIds);
  return { channelId: args.chat, ...result };
}

// args: { chat }. Revokes the primary invite link, returning the new descriptor.
async function revokeGroupInviteLink(ctx, args = {}) {
  const existing = await ctx.telegramClient.getGroupInviteLink(args.chat);
  return ctx.telegramClient.revokeGroupInviteLink(args.chat, existing);
}

// args: { chat }. Leaves a group.
async function groupsLeave(ctx, args = {}) {
  await ctx.telegramClient.leaveGroup(args.chat);
  return { channelId: args.chat, left: true };
}

// --- folders ---

// args: folder definition fields. Creates a folder.
async function foldersCreate(ctx, args = {}) {
  return ctx.telegramClient.createFolder({
    title: args.title,
    emoji: args.emoji,
    contacts: args.contacts,
    nonContacts: args.nonContacts,
    groups: args.groups,
    broadcasts: args.broadcasts,
    bots: args.bots,
    excludeMuted: args.excludeMuted,
    excludeRead: args.excludeRead,
    excludeArchived: args.excludeArchived,
    includePeers: args.includePeers,
    excludePeers: args.excludePeers,
    pinnedPeers: args.pinnedPeers,
  });
}

// --- passthrough ops ---

// Simple ops are a 1:1 forward to a warm service method whose result is returned
// unchanged. Each entry maps the op's args object to that method's call
// arguments; PASSTHROUGHS expands into handlers with the same (ctx, args) =>
// result contract as the hand-written ops. Anything that reshapes a result,
// applies defaults beyond a plain map, or calls more than one method stays a
// hand-written composite above.
const PASSTHROUGHS = {
  channelMarkRead: ['telegramClient', 'markChannelRead', (a) => [a.chat, a.messageId]],
  mediaDownload: ['telegramClient', 'downloadMessageMedia', (a) => [a.channelId, a.messageId, { outputPath: a.outputPath }]],
  tagsList: ['messageSyncService', 'listChannelTags', (a) => [a.chat, { source: a.source }]],
  tagsSearch: ['messageSyncService', 'listTaggedChannels', (a) => [a.tag, { source: a.source, limit: a.limit ?? 100 }]],
  groupsList: ['telegramClient', 'listGroups', (a) => [{ query: a.query, limit: a.limit ?? 100 }]],
  groupsInfo: ['telegramClient', 'getGroupInfo', (a) => [a.chat]],
  getGroupInviteLink: ['telegramClient', 'getGroupInviteLink', (a) => [a.chat]],
  groupsJoin: ['telegramClient', 'joinGroup', (a) => [a.invite]],
  foldersList: ['telegramClient', 'getFolders', () => []],
  foldersShow: ['telegramClient', 'showFolder', (a) => [a.folder, { resolve: a.resolve }]],
  foldersEdit: ['telegramClient', 'editFolder', (a) => [a.folder, a.modification ?? {}]],
  foldersDelete: ['telegramClient', 'deleteFolder', (a) => [a.folder]],
  foldersReorder: ['telegramClient', 'setFoldersOrder', (a) => [a.ids]],
  foldersChatsAdd: ['telegramClient', 'addChatToFolder', (a) => [a.folder, a.chat]],
  foldersChatsRemove: ['telegramClient', 'removeChatFromFolder', (a) => [a.folder, a.chat]],
  foldersJoin: ['telegramClient', 'joinChatlist', (a) => [a.link]],
};

function buildPassthroughOps(table) {
  const ops = {};
  for (const [name, [target, method, mapArgs]] of Object.entries(table)) {
    ops[name] = (ctx, args = {}) => ctx[target][method](...mapArgs(args));
  }
  return ops;
}

export const OPERATIONS = {
  listChannels,
  channelShow,
  channelSetSync,
  messagesList,
  messagesSearch,
  messagesGet,
  messagesContext,
  sendText,
  sendPhoto,
  sendFile,
  topicsList,
  tagsSet,
  tagsAuto,
  metadataGet,
  metadataRefresh,
  contactsSearch,
  contactsShow,
  contactsAliasSet,
  contactsAliasRemove,
  contactsTagsAdd,
  contactsTagsRemove,
  contactsNotesSet,
  groupsRename,
  groupMembersAdd,
  groupMembersRemove,
  revokeGroupInviteLink,
  groupsLeave,
  foldersCreate,
  ...buildPassthroughOps(PASSTHROUGHS),
};

// Shared building blocks the ops use, re-exported so other layers can render
// live/merged message sets with the same formatting the ops produce rather than
// re-deriving it.
export {
  buildSendSuccessPayload,
  formatLiveMessage,
  mergeMessageSets,
  resolveSource,
  SendCommandError,
};
