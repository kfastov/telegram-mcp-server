import http from "http";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { z } from "zod";

import TelegramClient from "./telegram-client.js";
import MessageSyncService from "./message-sync-service.js";

dotenv.config();

const HOST = process.env.MCP_HOST ?? process.env.FASTMCP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MCP_PORT ?? process.env.FASTMCP_PORT ?? "8080");

const telegramClient = new TelegramClient(
  process.env.TELEGRAM_API_ID,
  process.env.TELEGRAM_API_HASH,
  process.env.TELEGRAM_PHONE_NUMBER,
  "./data/session.json",
);

const messageSyncService = new MessageSyncService(telegramClient, {
  dbPath: "./data/messages.db",
  batchSize: 100,
  interJobDelayMs: 3000,
  interBatchDelayMs: 1200,
});

let telegramReady = false;

async function initializeTelegram() {
  if (telegramReady) return;

  console.log("[startup] Initializing Telegram dialogs...");
  const dialogsReady = await telegramClient.initializeDialogCache();

  if (!dialogsReady) {
    throw new Error("Failed to initialize Telegram dialog list");
  }

  messageSyncService.resumePendingJobs();
  telegramReady = true;
}

/**
 * Represents an active MCP session – a transport plus its server instance.
 */
const sessions = new Map();

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

const getChannelMessagesSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  limit: z.number().int().positive().optional().describe("Maximum number of messages to return (default: 100)"),
  filterPattern: z
    .string()
    .optional()
    .describe("Optional regex to filter message content"),
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
};

function createServerInstance() {
  const server = new McpServer({
    name: "example-mcp-server",
    version: "1.0.0",
  });

  server.tool(
    "listChannels",
    "Lists available Telegram dialogs for the authenticated account.",
    listChannelsSchema,
    async ({ limit }) => {
      await telegramClient.ensureLogin();
      const dialogs = await telegramClient.listDialogs(limit ?? 50);

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
      const matches = await telegramClient.searchDialogs(keywords, limit ?? 100);

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
    "getChannelMessages",
    "Retrieves recent messages for a channel by numeric ID or username.",
    getChannelMessagesSchema,
    async ({ channelId, limit, filterPattern }) => {
      await telegramClient.ensureLogin();

      const { peerTitle, messages } = await telegramClient.getMessagesByChannelId(
        channelId,
        limit ?? 100,
      );

      let formatted = messages.map((msg) => ({
        id: msg.id,
        date: msg.date ? new Date(msg.date * 1000).toISOString() : "unknown",
        text: msg.text ?? msg.message ?? "",
        from_id: msg.from_id ?? "unknown",
      }));

      if (filterPattern) {
        try {
          const regex = new RegExp(filterPattern);
          formatted = formatted.filter((msg) => msg.text && regex.test(msg.text));
        } catch (error) {
          throw new Error(`Invalid filterPattern: ${error.message}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                peerTitle,
                totalFetched: messages.length,
                returned: formatted.length,
                messages: formatted,
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
    "scheduleMessageSync",
    "Schedules a background job to archive channel messages locally.",
    scheduleMessageSyncSchema,
    async ({ channelId, depth }) => {
      await telegramClient.ensureLogin();
      const job = messageSyncService.addJob(channelId, { depth });
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

  return server;
}

async function ensureSession(req, res, body) {
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
        void existing.server?.close().catch((error) => {
          console.error(`[server] error closing session ${sessionId}: ${error.message}`);
        });
      }
      sessions.delete(sessionId);
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
    void record.server?.close().catch((error) => {
      console.error(`[server] error closing transport session: ${error.message}`);
    });
  };

  const serverInstance = createServerInstance();
  record.server = serverInstance;

  await serverInstance.connect(transport);

  return record;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req
      .on("data", (chunk) => chunks.push(chunk))
      .on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve(raw.length ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      })
      .on("error", (error) => reject(error));
  });
}

async function handlePost(req, res) {
  const body = await readBody(req);
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

await initializeTelegram().catch((error) => {
  console.error(`[startup] Telegram initialization failed: ${error?.message ?? error}`);
  process.exit(1);
});

const server = http.createServer(async (req, res) => {
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

server.listen(PORT, HOST, () => {
  console.log(`[startup] MCP HTTP server listening on http://${HOST}:${PORT}/mcp`);
});

server.on("error", (error) => {
  console.error(`[http] server error: ${error.message}`);
});

async function shutdown() {
  console.log("[shutdown] received termination signal, closing resources...");
  server.closeAllConnections?.();
  server.close(() => {
    console.log("[shutdown] HTTP server closed");
  });

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
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
