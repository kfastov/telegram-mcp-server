import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { readJsonBody, sendJson } from './http-util.js';
import { OPERATIONS } from './operations.js';
import { SendCommandError } from './send-utils.js';

export const CONTROL_FILE = 'control.json';
export const CONTROL_TOKEN_HEADER = 'x-tgcli-control-token';

// Generate a fresh control secret. Loopback binding plus this token are the two
// layers guarding the always-on control API.
export function generateControlToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Write <store>/control.json with mode 0600 so only the owner can read the token.
// Returns the descriptor written so callers can hold onto it.
export function writeControlFile(storeDir, descriptor) {
  fs.mkdirSync(storeDir, { recursive: true });
  const filePath = path.join(storeDir, CONTROL_FILE);
  fs.writeFileSync(filePath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync only applies mode on create; chmod guards the overwrite case.
  fs.chmodSync(filePath, 0o600);
  return descriptor;
}

export function removeControlFile(storeDir) {
  const filePath = path.join(storeDir, CONTROL_FILE);
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

// Pure idle predicate, shared by the server idle monitor and its unit tests.
// Idle = no queued/in-flight jobs AND no watched channels AND control API has
// been quiet longer than the configured window.
export function isIdle({ jobCounts, watchedCount, lastActivityAt, now, idleExitMs }) {
  if (!Number.isFinite(idleExitMs) || idleExitMs <= 0) {
    return false;
  }
  const pending = jobCounts?.pending ?? 0;
  const inProgress = jobCounts?.inProgress ?? 0;
  if (pending > 0 || inProgress > 0) {
    return false;
  }
  if ((watchedCount ?? 0) > 0) {
    return false;
  }
  return now - lastActivityAt > idleExitMs;
}

/**
 * Builds the request handler for the loopback control API. Every endpoint
 * delegates to the same MessageSyncService methods the MCP tools use, so there
 * is no duplicated job logic. The returned handler is meant to back a dedicated
 * http.Server bound to loopback.
 *
 * @param {object} deps
 * @param {object} deps.service       MessageSyncService (or compatible stub).
 * @param {object} [deps.warmServices] Warm { telegramClient, messageSyncService }
 *                                     the shared operation handlers run against
 *                                     for /control/invoke.
 * @param {string} deps.token         Secret required in the control token header.
 * @param {number} deps.pid           Server process id.
 * @param {string} deps.version       Server version string.
 * @param {string} deps.startedAt     ISO timestamp the server started.
 * @param {Function} [deps.onActivity] Called on every authed request (idle reset).
 * @param {Function} [deps.ensureLogin] Optional async hook run before enqueue.
 */
export function createControlRequestHandler({
  service,
  warmServices,
  token,
  pid,
  version,
  startedAt,
  onActivity,
  ensureLogin,
}) {
  return async function handleControlRequest(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '', 'http://127.0.0.1');
    } catch (error) {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }

    if (!url.pathname.startsWith('/control/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const provided = req.headers[CONTROL_TOKEN_HEADER];
    if (!provided || provided !== token) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (typeof onActivity === 'function') {
      onActivity();
    }

    try {
      if (req.method === 'GET' && url.pathname === '/control/ping') {
        sendJson(res, 200, {
          ok: true,
          pid,
          version,
          startedAt,
          jobs: service.getJobCounts(),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/control/backfill') {
        const body = await readJsonBody(req);
        const chatId = body?.chatId;
        if (chatId === undefined || chatId === null || String(chatId).trim() === '') {
          sendJson(res, 400, { error: 'chatId is required' });
          return;
        }
        if (typeof ensureLogin === 'function') {
          await ensureLogin();
        }
        // Canonicalize the chat reference before enqueueing so the job row and
        // the backfilled messages share the marked-id key the live-sync writer
        // uses. Unresolvable ids fail here (500 with the resolution hint, via
        // the outer catch) instead of leaving a phantom channels row plus a
        // job that errors later.
        const canonicalChatId = typeof warmServices?.telegramClient?.canonicalizeChannelId === 'function'
          ? await warmServices.telegramClient.canonicalizeChannelId(chatId)
          : chatId;
        // Same path as the scheduleMessageSync MCP tool: enqueue then kick the
        // queue so processing starts without waiting for the next trigger.
        const job = service.addJob(canonicalChatId, { depth: body?.depth, minDate: body?.minDate });
        void service.processQueue();
        sendJson(res, 200, {
          jobId: job?.id ?? null,
          channelId: job?.channel_id ?? null,
          status: job?.status ?? null,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/control/invoke') {
        const body = await readJsonBody(req);
        const op = body?.op;
        const handler = typeof op === 'string' ? OPERATIONS[op] : undefined;
        if (!handler) {
          sendJson(res, 400, { error: `Unknown operation: ${op ?? ''}` });
          return;
        }
        // The warm client serves these operations, so make sure it is logged in
        // before the handler touches MTProto.
        if (typeof ensureLogin === 'function') {
          await ensureLogin();
        }
        try {
          const result = await handler(warmServices, body?.args ?? {});
          sendJson(res, 200, { result });
        } catch (error) {
          // A send op carries structured failure details; relay them so the CLI
          // renders the same human/JSON error a local send would.
          if (error instanceof SendCommandError) {
            sendJson(res, 500, { error: error.message, sendError: error.details });
          } else {
            sendJson(res, 500, { error: error?.message ?? 'Operation failed' });
          }
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/control/retry') {
        const body = await readJsonBody(req);
        const jobId = body?.jobId;
        const channelId = body?.channelId;
        const allErrors = Boolean(body?.allErrors);
        if (
          !allErrors &&
          (jobId === undefined || jobId === null) &&
          (channelId === undefined || channelId === null || String(channelId).trim() === '')
        ) {
          sendJson(res, 400, { error: 'Provide jobId, channelId, or allErrors' });
          return;
        }
        // Same logic as `sync jobs retry`: reset the errored job(s) to pending,
        // then kick the queue so the server's worker picks them back up.
        const result = service.retryJobs({ jobId, channelId, allErrors });
        if (result.updated > 0) {
          void service.processQueue();
        }
        sendJson(res, 200, {
          updated: result.updated,
          jobIds: result.jobIds,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/control/cancel') {
        const body = await readJsonBody(req);
        const chatId = body?.chatId;
        const jobId = body?.jobId;
        if (
          (chatId === undefined || chatId === null || String(chatId).trim() === '') &&
          (jobId === undefined || jobId === null)
        ) {
          sendJson(res, 400, { error: 'Provide chatId or jobId' });
          return;
        }
        // Same logic as `sync jobs cancel`.
        const result = service.cancelJobs({ channelId: chatId, jobId });
        sendJson(res, 200, {
          canceled: result.canceled,
          jobIds: result.jobIds,
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error?.message ?? 'Internal error' });
      }
    }
  };
}
