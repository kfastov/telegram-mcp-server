import http from "http";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { loadConfig, validateConfig } from "./core/config.js";
import { createServices } from "./core/services.js";
import { resolveStoreDir } from "./core/store.js";
import {
  createControlRequestHandler,
  generateControlToken,
  writeControlFile,
  removeControlFile,
  isIdle,
} from "./core/control-server.js";
import { readJsonBody } from "./core/http-util.js";
import { parseDuration } from "./core/duration.js";
import { OPERATIONS } from "./core/operations.js";

const SERVICE_STATE_FILE = "service-state.json";

const storeDir = resolveStoreDir();
const { config, path: configPath } = loadConfig(storeDir);
const missingConfig = validateConfig(config ?? {});
if (missingConfig.length > 0) {
  console.error(`[startup] Missing tgcli configuration at ${configPath}. Run "tgcli auth".`);
  process.exit(1);
}
const mcpConfig = config?.mcp ?? {};
const mcpEnabled = Boolean(mcpConfig.enabled);
const resolvedHost = mcpConfig.host ?? process.env.MCP_HOST ?? process.env.FASTMCP_HOST ?? "127.0.0.1";
const resolvedPort = Number(mcpConfig.port ?? process.env.MCP_PORT ?? process.env.FASTMCP_PORT ?? "8080");
const HOST = resolvedHost;
const PORT = Number.isFinite(resolvedPort) && resolvedPort > 0 ? resolvedPort : 8080;

// Always-on loopback control API. Separate listener from MCP and not gated by
// mcp.enabled; bound to loopback only.
const controlConfig = config?.control ?? {};
const controlEnabled = controlConfig.enabled !== false;
const CONTROL_HOST = controlConfig.host ?? "127.0.0.1";
const controlPortRaw = Number(controlConfig.port ?? 8765);
const CONTROL_PORT = Number.isFinite(controlPortRaw) && controlPortRaw > 0 ? controlPortRaw : 8765;

// Idle-exit window (ms). Plumbed from the CLI `server --idle-exit <duration>`
// via argv or the TGCLI_IDLE_EXIT env var. When unset/zero the server stays up
// forever. See resolveIdleExitMs for the ms-vs-duration-string handling.
const IDLE_EXIT_MS = resolveIdleExitMs(readIdleExitArg());
const IDLE_CHECK_INTERVAL_MS = 5000;

const { telegramClient, messageSyncService } = createServices({ storeDir, config });

let telegramReady = false;
let serviceState = null;
let controlToken = null;
let controlServer = null;
let idleTimer = null;
let lastControlActivityAt = Date.now();

function readIdleExitArg() {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf("--idle-exit");
  if (flagIndex !== -1 && args[flagIndex + 1]) {
    return args[flagIndex + 1];
  }
  const inline = args.find((arg) => arg.startsWith("--idle-exit="));
  if (inline) {
    return inline.slice("--idle-exit=".length);
  }
  return process.env.TGCLI_IDLE_EXIT ?? null;
}

// Resolve the idle-exit window to milliseconds. The CLI forwards `--idle-exit`
// as a plain integer of milliseconds (it has already parsed the user's duration
// via parseDuration), so a bare integer here is treated AS-IS as ms. A value
// carrying a unit suffix (e.g. "60s", "5m" from TGCLI_IDLE_EXIT) is parsed with
// the shared parseDuration (where a bare number would mean seconds, but that
// branch never applies here because bare integers are short-circuited above).
// This explicit split avoids the previous accidental divergence where the same
// bare number meant seconds in the CLI but milliseconds in the server.
function resolveIdleExitMs(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  try {
    return parseDuration(raw) ?? 0;
  } catch (error) {
    return 0;
  }
}

function readVersion() {
  try {
    const pkgPath = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "0.0.0";
  } catch (error) {
    return "0.0.0";
  }
}

function writeServiceState(nextState) {
  if (!nextState) {
    return;
  }
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(
      path.join(storeDir, SERVICE_STATE_FILE),
      `${JSON.stringify(nextState, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    console.error(`[startup] Failed to write service state: ${error?.message ?? error}`);
  }
}

function updateServiceState(patch) {
  if (!serviceState) {
    return;
  }
  serviceState = {
    ...serviceState,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeServiceState(serviceState);
}

async function initializeTelegram() {
  if (telegramReady) return;

  console.log("[startup] Initializing Telegram dialogs...");
  const dialogsReady = await telegramClient.initializeDialogCache();

  if (!dialogsReady) {
    throw new Error("Failed to initialize Telegram dialog list");
  }

  const dialogCount = await messageSyncService.refreshChannelsFromDialogs();
  console.log(`[startup] Seeded ${dialogCount} dialogs into archive registry.`);
  messageSyncService.startRealtimeSync();
  messageSyncService.resumePendingJobs();
  telegramReady = true;
}

/**
 * Represents an active MCP session – a transport plus its server instance.
 */
const sessions = new Map();
let shuttingDown = false;

function closeSessionRecord(record, context) {
  if (!record || record.closing) {
    return null;
  }
  record.closing = true;
  if (record.sessionId) {
    sessions.delete(record.sessionId);
  }
  if (record.transport?.close) {
    return record.transport.close().catch((error) => {
      console.error(`[server] error closing ${context}: ${error.message}`);
    });
  }
  return null;
}

const listChannelsSchema = {
  limit: z.number().int().positive().optional().describe("Maximum number of channels to return (default: 50)"),
};

const searchChannelsSchema = {
  keywords: z
    .string()
    .min(1)
    .describe("Keywords to search for in channel titles or usernames"),
  limit: z.number().int().positive().optional().describe("Maximum number of results to return (default: 100)"),
};

const setChannelTagsSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  tags: z
    .array(z.string().min(1))
    .min(1)
    .describe("List of tags to attach to the channel"),
  source: z
    .string()
    .optional()
    .describe("Tag source label (default: manual)"),
};

const listChannelTagsSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  source: z
    .string()
    .optional()
    .describe("Optional tag source to filter by"),
};

const listTaggedChannelsSchema = {
  tag: z
    .string()
    .min(1)
    .describe("Tag label to look up"),
  source: z
    .string()
    .optional()
    .describe("Optional tag source to filter by"),
  limit: z.number().int().positive().optional().describe("Maximum number of channels to return (default: 100)"),
};

const refreshChannelMetadataSchema = {
  channelIds: z
    .array(
      z.union([
        z.number({ invalid_type_error: "channelId must be a number" }),
        z.string({ invalid_type_error: "channelId must be a string" }).min(1),
      ]),
    )
    .optional()
    .describe("Optional list of channel IDs/usernames to refresh"),
  limit: z.number().int().positive().optional().describe("Maximum number of channels to refresh (default: 20)"),
  force: z
    .boolean({ invalid_type_error: "force must be a boolean" })
    .optional()
    .describe("Refresh even if cached metadata is fresh"),
  onlyMissing: z
    .boolean({ invalid_type_error: "onlyMissing must be a boolean" })
    .optional()
    .describe("Refresh only channels without cached metadata"),
};

const getChannelMetadataSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
};

const autoTagChannelsSchema = {
  channelIds: z
    .array(
      z.union([
        z.number({ invalid_type_error: "channelId must be a number" }),
        z.string({ invalid_type_error: "channelId must be a string" }).min(1),
      ]),
    )
    .optional()
    .describe("Optional list of channel IDs/usernames to tag"),
  limit: z.number().int().positive().optional().describe("Maximum number of channels to tag (default: 50)"),
  source: z
    .string()
    .optional()
    .describe("Tag source label (default: auto)"),
  refreshMetadata: z
    .boolean({ invalid_type_error: "refreshMetadata must be a boolean" })
    .optional()
    .describe("Refresh cached metadata before tagging (default true)"),
};

const scheduleMessageSyncSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  depth: z
    .number({ invalid_type_error: "depth must be a number" })
    .int()
    .positive()
    .max(50000)
    .optional()
    .describe("Maximum messages to retain per channel (default 1000)"),
  minDate: z
    .string({ invalid_type_error: "minDate must be a string" })
    .min(1)
    .optional()
    .describe("Earliest ISO-8601 timestamp to backfill (optional)"),
};

const topicsListSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
  .describe("Numeric channel ID or username"),
  limit: z.number().int().positive().optional().describe("Maximum number of topics to return (default: 100)"),
};

const topicsSearchSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  query: z
    .string({ invalid_type_error: "query must be a string" })
    .min(1)
    .describe("Search query for forum topic titles"),
  limit: z.number().int().positive().optional().describe("Maximum number of topics to return (default: 100)"),
};

const messageSourceSchema = z
  .enum(["archive", "live", "both"])
  .optional()
  .describe("Message source (default: archive)");

const channelIdSchema = z.union([
  z.number({ invalid_type_error: "channelId must be a number" }),
  z.string({ invalid_type_error: "channelId must be a string" }).min(1),
]);

const markChannelReadSchema = {
  channelId: channelIdSchema.describe("Numeric channel ID or username"),
  messageId: z
    .number({ invalid_type_error: "messageId must be a number" })
    .int()
    .positive()
    .describe("Mark as read up to this message ID (inclusive)"),
};

const userIdSchema = z.union([
  z.number({ invalid_type_error: "userId must be a number" }),
  z.string({ invalid_type_error: "userId must be a string" }).min(1),
]);

const messagesListSchema = {
  channelId: channelIdSchema.optional().describe("Optional numeric channel ID or username"),
  topicId: z
    .number({ invalid_type_error: "topicId must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Optional forum topic ID"),
  source: messageSourceSchema,
  fromDate: z
    .string({ invalid_type_error: "fromDate must be a string" })
    .min(1)
    .optional()
    .describe("Earliest ISO-8601 timestamp to include (optional)"),
  toDate: z
    .string({ invalid_type_error: "toDate must be a string" })
    .min(1)
    .optional()
    .describe("Latest ISO-8601 timestamp to include (optional)"),
  limit: z.number().int().positive().optional().describe("Maximum number of messages to return (default: 50)"),
};

const messagesGetSchema = {
  channelId: channelIdSchema.describe("Numeric channel ID or username"),
  messageId: z
    .number({ invalid_type_error: "messageId must be a number" })
    .int()
    .positive()
    .describe("Message ID"),
  source: messageSourceSchema,
};

const messagesContextSchema = {
  channelId: channelIdSchema.describe("Numeric channel ID or username"),
  messageId: z
    .number({ invalid_type_error: "messageId must be a number" })
    .int()
    .positive()
    .describe("Message ID"),
  before: z
    .number({ invalid_type_error: "before must be a number" })
    .int()
    .min(0)
    .optional()
    .describe("Number of messages to include before the target (default: 20)"),
  after: z
    .number({ invalid_type_error: "after must be a number" })
    .int()
    .min(0)
    .optional()
    .describe("Number of messages to include after the target (default: 20)"),
  source: messageSourceSchema,
};

const messagesSearchSchema = {
  query: z.string().optional().describe("Optional full-text query (archive) or search text (live)"),
  regex: z.string().optional().describe("Optional regex filter for message text"),
  source: messageSourceSchema,
  channelIds: z
    .union([channelIdSchema, z.array(channelIdSchema).min(1)])
    .optional()
    .describe("Channel IDs or usernames to search (optional)"),
  channelId: channelIdSchema.optional().describe("Alias for channelIds"),
  tags: z.array(z.string().min(1)).optional().describe("Channel tags to filter by (optional)"),
  tag: z.string().optional().describe("Alias for tags"),
  topicId: z
    .number({ invalid_type_error: "topicId must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Optional forum topic ID"),
  fromDate: z
    .string({ invalid_type_error: "fromDate must be a string" })
    .min(1)
    .optional()
    .describe("Earliest ISO-8601 timestamp to include (optional)"),
  toDate: z
    .string({ invalid_type_error: "toDate must be a string" })
    .min(1)
    .optional()
    .describe("Latest ISO-8601 timestamp to include (optional)"),
  limit: z.number().int().positive().optional().describe("Maximum number of matches to return (default: 100)"),
  caseInsensitive: z
    .boolean({ invalid_type_error: "caseInsensitive must be a boolean" })
    .optional()
    .describe("Whether regex matching should be case-insensitive (default: true)"),
};

const messagesSendSchema = {
  channelId: channelIdSchema.describe("Numeric channel ID or username"),
  text: z
    .string({ invalid_type_error: "text must be a string" })
    .min(1)
    .describe("Message text to send"),
  topicId: z
    .number({ invalid_type_error: "topicId must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Optional forum topic ID to send into"),
  replyToMessageId: z
    .number({ invalid_type_error: "replyToMessageId must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Optional message ID to reply to"),
};

const messagesSendFileSchema = {
  channelId: channelIdSchema.describe("Numeric channel ID or username"),
  filePath: z
    .string({ invalid_type_error: "filePath must be a string" })
    .min(1)
    .describe("Path to a local file to upload"),
  caption: z.string().optional().describe("Optional caption for the file"),
  filename: z.string().optional().describe("Override file name shown in Telegram"),
  topicId: z
    .number({ invalid_type_error: "topicId must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Optional forum topic ID to send into"),
};

const mediaDownloadSchema = {
  channelId: channelIdSchema.describe("Numeric channel ID or username"),
  messageId: z
    .number({ invalid_type_error: "messageId must be a number" })
    .int()
    .positive()
    .describe("Message ID containing media"),
  outputPath: z
    .string()
    .min(1)
    .optional()
    .describe("Optional file path or directory for the download"),
};

const contactsSearchSchema = {
  query: z
    .string({ invalid_type_error: "query must be a string" })
    .min(1)
    .describe("Search query for contacts"),
  limit: z.number().int().positive().optional().describe("Maximum number of contacts to return (default: 50)"),
};

const contactsGetSchema = {
  userId: userIdSchema.describe("User ID or username"),
};

const contactsAliasSetSchema = {
  userId: userIdSchema.describe("User ID or username"),
  alias: z
    .string({ invalid_type_error: "alias must be a string" })
    .min(1)
    .describe("Alias for the contact"),
};

const contactsAliasRemoveSchema = {
  userId: userIdSchema.describe("User ID or username"),
};

const contactsTagsAddSchema = {
  userId: userIdSchema.describe("User ID or username"),
  tags: z.array(z.string().min(1)).min(1).describe("Tags to add"),
};

const contactsTagsRemoveSchema = {
  userId: userIdSchema.describe("User ID or username"),
  tags: z.array(z.string().min(1)).min(1).describe("Tags to remove"),
};

const contactsNotesSetSchema = {
  userId: userIdSchema.describe("User ID or username"),
  notes: z
    .string({ invalid_type_error: "notes must be a string" })
    .describe("Notes to attach to the contact"),
};

const groupsListSchema = {
  query: z.string().optional().describe("Optional search query for group titles"),
  limit: z.number().int().positive().optional().describe("Maximum number of groups to return (default: 100)"),
};

const groupsInfoSchema = {
  channelId: channelIdSchema.describe("Group ID or username"),
};

const groupsRenameSchema = {
  channelId: channelIdSchema.describe("Group ID or username"),
  name: z
    .string({ invalid_type_error: "name must be a string" })
    .min(1)
    .describe("New group title"),
};

const groupsMembersAddSchema = {
  channelId: channelIdSchema.describe("Group ID or username"),
  userIds: z
    .array(userIdSchema)
    .min(1)
    .describe("User IDs or usernames to add"),
};

const groupsMembersRemoveSchema = {
  channelId: channelIdSchema.describe("Group ID or username"),
  userIds: z
    .array(userIdSchema)
    .min(1)
    .describe("User IDs or usernames to remove"),
};

const groupsInviteLinkGetSchema = {
  channelId: channelIdSchema.describe("Group ID or username"),
};

const groupsInviteLinkRevokeSchema = {
  channelId: channelIdSchema.describe("Group ID or username"),
};

const groupsJoinSchema = {
  invite: z
    .string({ invalid_type_error: "invite must be a string" })
    .min(1)
    .describe("Invite link or code"),
};

const groupsLeaveSchema = {
  channelId: channelIdSchema.describe("Group ID or username"),
};

function resolveChannelIds(channelIds, channelId) {
  const resolved = [];
  if (Array.isArray(channelIds)) {
    resolved.push(...channelIds);
  } else if (channelIds) {
    resolved.push(channelIds);
  }
  if (channelId) {
    resolved.push(channelId);
  }
  const filtered = resolved.filter((id) => id !== null && id !== undefined && String(id).trim() !== "");
  return filtered.length ? filtered : null;
}

function formatInviteLink(link) {
  if (!link) {
    return null;
  }
  return {
    link: link.link ?? null,
    isPrimary: typeof link.isPrimary === "boolean" ? link.isPrimary : null,
    isRevoked: typeof link.isRevoked === "boolean" ? link.isRevoked : null,
    createdAt: link.date ? link.date.toISOString() : null,
    startDate: link.startDate ? link.startDate.toISOString() : null,
    endDate: link.endDate ? link.endDate.toISOString() : null,
    usageLimit: typeof link.usageLimit === "number" ? link.usageLimit : null,
    usage: typeof link.usage === "number" ? link.usage : null,
    approvalNeeded: typeof link.approvalNeeded === "boolean" ? link.approvalNeeded : null,
    pendingApprovals: typeof link.pendingApprovals === "number" ? link.pendingApprovals : null,
  };
}

function createServerInstance() {
  const server = new McpServer({
    name: "example-mcp-server",
    version: "1.0.0",
  });

  // The shared operation handlers run against the same warm services the control
  // API uses, so an MCP tool and the matching CLI command execute identical logic.
  const warmServices = { telegramClient, messageSyncService };

  server.tool(
    "listChannels",
    "Lists available Telegram dialogs for the authenticated account, including unread message counts.",
    listChannelsSchema,
    async ({ limit }) => {
      await telegramClient.ensureLogin();
      const dialogs = await OPERATIONS.listChannels(warmServices, { limit });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(dialogs, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "searchChannels",
    "Searches dialogs by title or username.",
    searchChannelsSchema,
    async ({ keywords, limit }) => {
      await telegramClient.ensureLogin();
      const matches = await OPERATIONS.listChannels(warmServices, { query: keywords, limit: limit ?? 100 });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(matches, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "listActiveChannels",
    "Lists dialogs tracked in the local archive registry.",
    {},
    async () => {
      const channels = messageSyncService.listActiveChannels();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(channels, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "setChannelTags",
    "Assign tags to a channel for later cross-channel search.",
    setChannelTagsSchema,
    async ({ channelId, tags, source }) => {
      const result = await OPERATIONS.tagsSet(warmServices, { chat: channelId, tags, source });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channelId, tags: result.tags }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "listChannelTags",
    "List tags attached to a channel.",
    listChannelTagsSchema,
    async ({ channelId, source }) => {
      const tags = await OPERATIONS.tagsList(warmServices, { chat: channelId, source });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(tags, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "listTaggedChannels",
    "List channels that carry a specific tag.",
    listTaggedChannelsSchema,
    async ({ tag, source, limit }) => {
      const channels = await OPERATIONS.tagsSearch(warmServices, { tag, source, limit });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(channels, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "refreshChannelMetadata",
    "Fetches and caches extended metadata for channels.",
    refreshChannelMetadataSchema,
    async ({ channelIds, limit, force, onlyMissing }) => {
      await telegramClient.ensureLogin();
      const results = await OPERATIONS.metadataRefresh(warmServices, {
        channelIds,
        limit,
        force,
        onlyMissing,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "getChannelMetadata",
    "Returns cached metadata for a channel.",
    getChannelMetadataSchema,
    async ({ channelId }) => {
      const metadata = messageSyncService.getChannelMetadata(channelId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(metadata, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "autoTagChannels",
    "Auto-tags channels based on title, username, and cached metadata.",
    autoTagChannelsSchema,
    async ({ channelIds, limit, source, refreshMetadata }) => {
      await telegramClient.ensureLogin();
      const results = await OPERATIONS.tagsAuto(warmServices, {
        channelIds,
        limit,
        source,
        refreshMetadata,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "topicsList",
    "Lists forum topics for a supergroup.",
    topicsListSchema,
    async ({ channelId, limit }) => {
      await telegramClient.ensureLogin();
      const { topics } = await OPERATIONS.topicsList(warmServices, { channelId, limit: limit ?? 100 });

      const formatted = topics.map((topic) => {
        let lastMessage = null;
        try {
          const msg = topic.lastMessage;
          lastMessage = {
            id: msg.id,
            date: msg.date ? msg.date.toISOString() : null,
            text: msg.text ?? msg.message ?? "",
          };
        } catch (error) {
          lastMessage = null;
        }

        return {
          id: topic.id,
          title: topic.title,
          date: topic.date ? topic.date.toISOString() : null,
          isClosed: topic.isClosed,
          isPinned: topic.isPinned,
          unreadCount: topic.unreadCount,
          lastMessage,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: topics.total ?? formatted.length,
                returned: formatted.length,
                topics: formatted,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "topicsSearch",
    "Searches forum topics by title.",
    topicsSearchSchema,
    async ({ channelId, query, limit }) => {
      await telegramClient.ensureLogin();
      const { topics } = await OPERATIONS.topicsList(warmServices, { channelId, query, limit: limit ?? 100 });

      const formatted = topics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        date: topic.date ? topic.date.toISOString() : null,
        isClosed: topic.isClosed,
        isPinned: topic.isPinned,
        unreadCount: topic.unreadCount,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: topics.total ?? formatted.length,
                returned: formatted.length,
                topics: formatted,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesList",
    "Lists messages from the archive or live Telegram API.",
    messagesListSchema,
    async ({ channelId, topicId, source, fromDate, toDate, limit }) => {
      if ((source === "live" || source === "both") && !channelId) {
        throw new Error("channelId is required for live source.");
      }
      await telegramClient.ensureLogin();
      const result = await OPERATIONS.messagesList(warmServices, {
        channelId,
        topicId,
        source,
        fromDate,
        toDate,
        limit: limit ?? 50,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: result.source,
                returned: result.returned,
                messages: result.messages,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesGet",
    "Fetches a specific message from the archive or live Telegram API.",
    messagesGetSchema,
    async ({ channelId, messageId, source }) => {
      await telegramClient.ensureLogin();
      const result = await OPERATIONS.messagesGet(warmServices, { channelId, messageId, source });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: result.source,
                message: result.message,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesContext",
    "Returns surrounding messages for a target message.",
    messagesContextSchema,
    async ({ channelId, messageId, before, after, source }) => {
      await telegramClient.ensureLogin();
      const result = await OPERATIONS.messagesContext(warmServices, {
        channelId,
        messageId,
        before,
        after,
        source,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: result.source,
                target: result.target,
                before: result.before,
                after: result.after,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesSearch",
    "Searches messages across the archive or live Telegram API.",
    messagesSearchSchema,
    async ({
      query,
      regex,
      source,
      channelIds,
      channelId,
      tags,
      tag,
      topicId,
      fromDate,
      toDate,
      limit,
      caseInsensitive,
    }) => {
      const resolvedChannelIds = resolveChannelIds(channelIds, channelId);
      const resolvedTags = Array.isArray(tags) ? tags : (tag ? [tag] : null);
      await telegramClient.ensureLogin();
      const result = await OPERATIONS.messagesSearch(warmServices, {
        query,
        regex,
        source,
        channelIds: resolvedChannelIds,
        tags: resolvedTags,
        topicId,
        fromDate,
        toDate,
        limit: limit ?? 100,
        caseInsensitive,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: result.source,
                returned: result.returned,
                messages: result.messages,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesSend",
    "Sends a text message to a channel or chat.",
    messagesSendSchema,
    async ({ channelId, text, topicId, replyToMessageId }) => {
      await telegramClient.ensureLogin();
      const { result } = await OPERATIONS.sendText(warmServices, {
        chat: channelId,
        text,
        topicId,
        replyToMessageId,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channelId, ...result }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesSendFile",
    "Sends a file with an optional caption.",
    messagesSendFileSchema,
    async ({ channelId, filePath, caption, filename, topicId }) => {
      await telegramClient.ensureLogin();
      const { result } = await OPERATIONS.sendFile(warmServices, {
        chat: channelId,
        file: filePath,
        caption,
        filename,
        topicId,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channelId, ...result }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "mediaDownload",
    "Downloads media from a message to a local file.",
    mediaDownloadSchema,
    async ({ channelId, messageId, outputPath }) => {
      await telegramClient.ensureLogin();
      const result = await OPERATIONS.mediaDownload(warmServices, { channelId, messageId, outputPath });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "contactsSearch",
    "Searches contacts/users with aliases, tags, and notes.",
    contactsSearchSchema,
    async ({ query, limit }) => {
      await telegramClient.ensureLogin();
      const contacts = await OPERATIONS.contactsSearch(warmServices, { query, limit });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(contacts, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "contactsGet",
    "Returns a contact profile from the local store.",
    contactsGetSchema,
    async ({ userId }) => {
      await telegramClient.ensureLogin();
      const contact = await OPERATIONS.contactsShow(warmServices, { userId });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(contact, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "contactsAliasSet",
    "Sets an alias for a contact.",
    contactsAliasSetSchema,
    async ({ userId, alias }) => {
      const result = await OPERATIONS.contactsAliasSet(warmServices, { userId, alias });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ userId, alias: result.alias }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "contactsAliasRemove",
    "Removes alias for a contact.",
    contactsAliasRemoveSchema,
    async ({ userId }) => {
      await OPERATIONS.contactsAliasRemove(warmServices, { userId });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ userId, removed: true }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "contactsTagsAdd",
    "Adds tags to a contact.",
    contactsTagsAddSchema,
    async ({ userId, tags }) => {
      const result = await OPERATIONS.contactsTagsAdd(warmServices, { userId, tags });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ userId, tags: result.tags }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "contactsTagsRemove",
    "Removes tags from a contact.",
    contactsTagsRemoveSchema,
    async ({ userId, tags }) => {
      const result = await OPERATIONS.contactsTagsRemove(warmServices, { userId, tags });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ userId, tags: result.tags }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "contactsNotesSet",
    "Sets notes for a contact.",
    contactsNotesSetSchema,
    async ({ userId, notes }) => {
      const result = await OPERATIONS.contactsNotesSet(warmServices, { userId, notes });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ userId, notes: result.notes }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "groupsList",
    "Lists group chats and supergroups.",
    groupsListSchema,
    async ({ query, limit }) => {
      await telegramClient.ensureLogin();
      const groups = await OPERATIONS.groupsList(warmServices, { query, limit });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(groups, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "groupsInfo",
    "Fetches group information and metadata.",
    groupsInfoSchema,
    async ({ channelId }) => {
      await telegramClient.ensureLogin();
      const info = await OPERATIONS.groupsInfo(warmServices, { chat: channelId });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "groupsRename",
    "Renames a group chat or supergroup.",
    groupsRenameSchema,
    async ({ channelId, name }) => {
      await telegramClient.ensureLogin();
      await OPERATIONS.groupsRename(warmServices, { chat: channelId, name });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channelId, name }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "groupsMembersAdd",
    "Adds members to a group.",
    groupsMembersAddSchema,
    async ({ channelId, userIds }) => {
      await telegramClient.ensureLogin();
      const result = await OPERATIONS.groupMembersAdd(warmServices, { chat: channelId, userIds });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channelId, failed: result.failed }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "groupsMembersRemove",
    "Removes members from a group.",
    groupsMembersRemoveSchema,
    async ({ channelId, userIds }) => {
      await telegramClient.ensureLogin();
      const result = await OPERATIONS.groupMembersRemove(warmServices, { chat: channelId, userIds });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channelId, removed: result.removed, failed: result.failed }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "groupsInviteLinkGet",
    "Gets the primary invite link for a group.",
    groupsInviteLinkGetSchema,
    async ({ channelId }) => {
      await telegramClient.ensureLogin();
      const link = await OPERATIONS.getGroupInviteLink(warmServices, { chat: channelId });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formatInviteLink(link), null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "groupsInviteLinkRevoke",
    "Revokes the primary invite link for a group.",
    groupsInviteLinkRevokeSchema,
    async ({ channelId }) => {
      await telegramClient.ensureLogin();
      const link = await OPERATIONS.revokeGroupInviteLink(warmServices, { chat: channelId });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formatInviteLink(link), null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "groupsJoin",
    "Joins a group using an invite link or code.",
    groupsJoinSchema,
    async ({ invite }) => {
      await telegramClient.ensureLogin();
      const chat = await OPERATIONS.groupsJoin(warmServices, { invite });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: chat.id?.toString?.() ?? null,
                title: chat.displayName || chat.title || "Unknown",
                username: chat.username ?? null,
                chatType: typeof chat.chatType === "string" ? chat.chatType : null,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "groupsLeave",
    "Leaves a group chat or channel.",
    groupsLeaveSchema,
    async ({ channelId }) => {
      await telegramClient.ensureLogin();
      await OPERATIONS.groupsLeave(warmServices, { chat: channelId });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channelId, left: true }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "scheduleMessageSync",
    "Schedules a background job to archive channel messages locally.",
    scheduleMessageSyncSchema,
    async ({ channelId, depth, minDate }) => {
      await telegramClient.ensureLogin();
      const job = messageSyncService.addJob(channelId, { depth, minDate });
      void messageSyncService.processQueue();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(job, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "getSyncedMessageStats",
    "Returns summary statistics for stored messages in a channel.",
    {
      channelId: z
        .union([
          z.number({ invalid_type_error: "channelId must be a number" }),
          z.string({ invalid_type_error: "channelId must be a string" }).min(1),
        ])
        .describe("Numeric channel ID or username"),
    },
    async ({ channelId }) => {
      const stats = messageSyncService.getMessageStats(channelId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "listMessageSyncJobs",
    "Lists tracked message sync jobs and their current status.",
    {},
    async () => {
      const jobs = messageSyncService.listJobs();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(jobs, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "markChannelRead",
    "Marks a Telegram channel as read up to the specified message ID.",
    markChannelReadSchema,
    async ({ channelId, messageId }) => {
      await telegramClient.ensureLogin();
      const result = await OPERATIONS.channelMarkRead(warmServices, { chat: channelId, messageId });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

async function ensureSession(req, res, body) {
  if (shuttingDown) {
    res.writeHead(503, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Server is shutting down",
        },
        id: null,
      }),
    );
    return null;
  }

  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && typeof sessionId === "string") {
    const existing = sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    res.writeHead(404, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Session not found",
        },
        id: null,
      }),
    );
    return null;
  }

  if (!isInitializeRequest(body)) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      }),
    );
    return null;
  }

  const record = { server: null, transport: null, sessionId: null };

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      record.sessionId = sessionId;
      sessions.set(sessionId, record);
    },
    onsessionclosed: (sessionId) => {
      const existing = sessions.get(sessionId);
      if (existing) {
        existing.closing = true;
        sessions.delete(sessionId);
      }
    },
  });

  record.transport = transport;

  transport.onerror = (error) => {
    console.error(`[transport] error: ${error.message}`);
  };

  transport.onclose = () => {
    if (record.sessionId) {
      sessions.delete(record.sessionId);
    }
  };

  const serverInstance = createServerInstance();
  record.server = serverInstance;

  await serverInstance.connect(transport);

  return record;
}

async function handlePost(req, res) {
  const body = await readJsonBody(req);
  const sessionRecord = await ensureSession(req, res, body);
  if (!sessionRecord) {
    return;
  }

  try {
    await sessionRecord.transport.handleRequest(req, res, body);
  } catch (error) {
    console.error(`[http] POST handling failed: ${error?.message ?? error}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        }),
      );
    }
  }
}

async function handleSessionRequest(req, res) {
  if (shuttingDown) {
    res.writeHead(503, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Server is shutting down",
        },
        id: null,
      }),
    );
    return;
  }

  const sessionIdHeader = req.headers["mcp-session-id"];
  if (!sessionIdHeader || typeof sessionIdHeader !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Invalid or missing session ID",
        },
        id: null,
      }),
    );
    return;
  }

  const record = sessions.get(sessionIdHeader);
  if (!record) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Session not found",
        },
        id: null,
      }),
    );
    return;
  }

  await record.transport.handleRequest(req, res);
}

// TODO: MCP server should participate in the store locking protocol.
// Currently it opens the SQLite DB and Telegram session without any lock,
// which can cause conflicts with concurrent CLI commands.
await initializeTelegram().catch((error) => {
  console.error(`[startup] Telegram initialization failed: ${error?.message ?? error}`);
  process.exit(1);
});

serviceState = {
  pid: process.pid,
  version: readVersion(),
  manager: process.env.TGCLI_SERVICE_MANAGER ?? "manual",
  startedAt: new Date().toISOString(),
  mcpEnabled,
  mcpHost: mcpEnabled ? HOST : null,
  mcpPort: mcpEnabled ? PORT : null,
};
writeServiceState(serviceState);

let httpServer = null;
if (mcpEnabled) {
  httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({ status: "ok" }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/mcp") {
        await handlePost(req, res);
        return;
      }

      if ((req.method === "GET" || req.method === "DELETE") && url.pathname === "/mcp") {
        await handleSessionRequest(req, res);
        return;
      }

      if (req.method === "POST") {
        res.writeHead(404, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32601,
              message: "Endpoint not found",
            },
            id: null,
          }),
        );
        return;
      }

      res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
    } catch (error) {
      console.error(`[http] unexpected error: ${error?.message ?? error}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          }),
        );
      }
    }
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`[startup] MCP HTTP server listening on http://${HOST}:${PORT}/mcp`);
  });

  httpServer.on("error", (error) => {
    console.error(`[http] server error: ${error.message}`);
  });
} else {
  console.log("[startup] MCP disabled; running sync-only service.");
}

// --- Always-on loopback control API (independent of mcp.enabled) ---
if (controlEnabled) {
  controlToken = generateControlToken();
  const startedAt = serviceState.startedAt;
  const handleControlRequest = createControlRequestHandler({
    service: messageSyncService,
    warmServices: { telegramClient, messageSyncService },
    token: controlToken,
    pid: process.pid,
    version: serviceState.version,
    startedAt,
    onActivity: () => {
      lastControlActivityAt = Date.now();
    },
    ensureLogin: () => telegramClient.ensureLogin(),
  });

  controlServer = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    void handleControlRequest(req, res);
  });

  controlServer.on("error", (error) => {
    console.error(`[control] server error: ${error.message}`);
  });

  controlServer.listen(CONTROL_PORT, CONTROL_HOST, () => {
    const address = controlServer.address();
    const boundPort = typeof address === "object" && address ? address.port : CONTROL_PORT;
    try {
      writeControlFile(storeDir, {
        pid: process.pid,
        port: boundPort,
        token: controlToken,
        startedAt,
        version: serviceState.version,
      });
    } catch (error) {
      console.error(`[control] failed to write control.json: ${error?.message ?? error}`);
    }
    console.log(`[startup] control API listening on http://${CONTROL_HOST}:${boundPort}/control`);
  });

  updateServiceState({
    controlEnabled: true,
    controlHost: CONTROL_HOST,
    controlPort: CONTROL_PORT,
  });
}

// --- Idle-exit monitor (active only when --idle-exit is configured) ---
if (IDLE_EXIT_MS > 0) {
  idleTimer = setInterval(() => {
    if (shuttingDown) {
      return;
    }
    const idle = isIdle({
      jobCounts: messageSyncService.getJobCounts(),
      watchedCount: messageSyncService.getWatchedChannelCount(),
      lastActivityAt: lastControlActivityAt,
      now: Date.now(),
      idleExitMs: IDLE_EXIT_MS,
    });
    if (idle) {
      console.log("[shutdown] idle window elapsed with no work; exiting.");
      void shutdown().finally(() => process.exit(0));
    }
  }, IDLE_CHECK_INTERVAL_MS);
  if (typeof idleTimer.unref === "function") {
    idleTimer.unref();
  }
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log("[shutdown] received termination signal, closing resources...");
  const closeTasks = [];
  for (const record of sessions.values()) {
    const task = closeSessionRecord(record, "shutdown");
    if (task) {
      closeTasks.push(task);
    }
  }
  if (closeTasks.length) {
    await Promise.allSettled(closeTasks);
  }
  if (httpServer) {
    httpServer.closeAllConnections?.();
    httpServer.close(() => {
      console.log("[shutdown] HTTP server closed");
    });
  }

  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }

  if (controlServer) {
    controlServer.closeAllConnections?.();
    controlServer.close(() => {
      console.log("[shutdown] control server closed");
    });
    controlServer = null;
  }

  if (controlEnabled) {
    try {
      removeControlFile(storeDir);
    } catch (error) {
      console.error(`[shutdown] failed to remove control.json: ${error?.message ?? error}`);
    }
  }

  try {
    await messageSyncService.shutdown();
  } catch (error) {
    console.error(`[shutdown] error while stopping message sync: ${error?.message ?? error}`);
  }

  try {
    await telegramClient.destroy();
  } catch (error) {
    console.error(`[shutdown] error while closing Telegram client: ${error?.message ?? error}`);
  }

  updateServiceState({
    stoppedAt: new Date().toISOString(),
    pid: null,
  });
}

const handleShutdownSignal = () => {
  void shutdown().finally(() => process.exit(0));
};

process.prependListener("SIGINT", handleShutdownSignal);
process.prependListener("SIGTERM", handleShutdownSignal);
