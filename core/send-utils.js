/**
 * Advanced error classification, retry execution, and payload builders for send commands.
 *
 * Backported from dapi/tgcli with simplifications.
 */

const DEFAULT_BACKOFF_MS = 1000;

const RETRY_BACKOFF_STRATEGIES = new Set(['constant', 'linear', 'exponential']);

const RETRYABLE_TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ERR_OPERATION_TIMED_OUT']);

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNABORTED', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE',
  'ENETDOWN', 'ENETRESET', 'ENETUNREACH', 'ERR_NETWORK',
]);

const VALIDATION_ERROR_CODES = new Set(['EACCES', 'EISDIR', 'ENOENT', 'EPERM']);

const TELEGRAM_ERROR_MARKERS = [
  'AUTH_KEY', 'BOT_METHOD_INVALID', 'CHANNEL_INVALID', 'CHANNEL_PRIVATE',
  'CHAT_ADMIN_REQUIRED', 'CHAT_SEND_MEDIA_FORBIDDEN', 'CHAT_SEND_PHOTOS_FORBIDDEN',
  'CHAT_WRITE_FORBIDDEN', 'FLOOD_WAIT', 'MESSAGE_ID_INVALID', 'MESSAGE_TOO_LONG',
  'PEER_ID_INVALID', 'PHOTO_INVALID', 'RPC', 'SCHEDULE', 'USER_BANNED_IN_CHANNEL',
];

const VALIDATION_MESSAGE_PATTERNS = [
  /^--/,
  /^File not found:/,
  /^Message text cannot be empty\./,
  /^filePath must be a string\./,
  /^Invalid parse mode\./,
  /^Invalid schedule date:/,
  /^Not authenticated\./,
];

// --- Helpers ---

export function formatErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'Unknown error');
}

function extractErrorCode(error) {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const code = error.code ?? error.errorCode ?? error.rpcCode ?? error.cause?.code ?? null;
  return code === undefined ? null : code;
}

function looksLikeValidationError(message, code) {
  if (code && VALIDATION_ERROR_CODES.has(String(code).toUpperCase())) {
    return true;
  }
  return VALIDATION_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function looksLikeTimeoutError(message, code) {
  const normalizedCode = code ? String(code).toUpperCase() : '';
  if (normalizedCode && RETRYABLE_TIMEOUT_CODES.has(normalizedCode)) {
    return true;
  }
  const lowered = message.toLowerCase();
  return lowered === 'timeout' || lowered.includes('timed out') || lowered.includes('timeout');
}

function looksLikeRetryableNetworkError(message, code) {
  const normalizedCode = code ? String(code).toUpperCase() : '';
  if (normalizedCode && RETRYABLE_NETWORK_CODES.has(normalizedCode)) {
    return true;
  }
  const lowered = message.toLowerCase();
  return lowered.includes('connection reset')
    || lowered.includes('connection aborted')
    || lowered.includes('broken pipe')
    || lowered.includes('temporary disconnect')
    || lowered.includes('network');
}

function looksLikeTransportError(message, error) {
  if (error?.name === 'TransportError') {
    return true;
  }
  return message.toLowerCase().includes('transport error');
}

export function parseRequiredWaitSeconds(error) {
  const message = formatErrorMessage(error);
  const floodWaitMatch = /FLOOD_WAIT_(\d+)/i.exec(message);
  if (floodWaitMatch) {
    return Number(floodWaitMatch[1]);
  }

  const requiredWaitMatch = /wait of (\d+) seconds/i.exec(message);
  if (requiredWaitMatch) {
    return Number(requiredWaitMatch[1]);
  }

  return null;
}

/**
 * Build a clear message for a FLOOD_WAIT that exceeds the send timeout budget,
 * so the failure reads as a rate limit rather than a generic timeout/hang.
 */
export function formatRateLimitTimeoutMessage(waitSeconds, timeoutMs) {
  const timeoutSeconds = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.round(timeoutMs / 1000)
    : null;
  const budget = timeoutSeconds !== null ? `the ${timeoutSeconds}s timeout` : 'the timeout';
  return `Telegram rate-limited this send (FLOOD_WAIT ${waitSeconds}s), which exceeds ${budget}. `
    + 'Retry later or pass --timeout 0.';
}

function looksLikeTelegramError(message, code, error) {
  if (typeof code === 'number') {
    return true;
  }
  if (error?.name === 'RpcError' || error?.name === 'MtRpcError') {
    return true;
  }
  const upper = message.toUpperCase();
  return TELEGRAM_ERROR_MARKERS.some((marker) => upper.includes(marker));
}

// --- Public API ---

/**
 * Error class for send command failures with structured details.
 */
export class SendCommandError extends Error {
  constructor(details) {
    super(details?.message ?? 'Send failed');
    this.name = 'SendCommandError';
    this.details = details;
  }
}

/**
 * Parse a retry backoff value from CLI input.
 * Accepts: numeric ms string, or strategy name (constant/linear/exponential).
 */
export function parseRetryBackoff(value) {
  if (value && typeof value === 'object' && typeof value.kind === 'string') {
    return {
      kind: value.kind,
      baseMs: Number.isFinite(value.baseMs) ? value.baseMs : DEFAULT_BACKOFF_MS,
      raw: value.raw ?? String(value.kind),
    };
  }

  if (value === undefined || value === null || value === '') {
    return { kind: 'constant', baseMs: DEFAULT_BACKOFF_MS, raw: String(DEFAULT_BACKOFF_MS) };
  }

  const normalized = String(value).trim().toLowerCase();
  if (/^\d+$/.test(normalized)) {
    return { kind: 'constant', baseMs: Number(normalized), raw: normalized };
  }
  if (RETRY_BACKOFF_STRATEGIES.has(normalized)) {
    return { kind: normalized, baseMs: DEFAULT_BACKOFF_MS, raw: normalized };
  }

  throw new Error('--retry-backoff must be a non-negative integer or one of: constant, linear, exponential');
}

/**
 * Compute the delay in ms for a given backoff strategy and attempt number.
 */
export function getRetryDelayMs(backoff, attempt) {
  const strategy = backoff?.kind ?? 'constant';
  const baseMs = Number.isFinite(backoff?.baseMs) ? backoff.baseMs : DEFAULT_BACKOFF_MS;

  if (strategy === 'linear') {
    return baseMs * attempt;
  }
  if (strategy === 'exponential') {
    return baseMs * (2 ** Math.max(0, attempt - 1));
  }
  return baseMs;
}

/**
 * Classify a send error into a structured details object.
 * Returns { type, method, message, code, attempt, retries, retryable }.
 */
export function classifySendError(error, { method, attempt = 1, retries = 0 } = {}) {
  if (error instanceof SendCommandError) {
    return error.details;
  }

  const message = formatErrorMessage(error);
  const code = extractErrorCode(error);
  const waitSeconds = parseRequiredWaitSeconds(error);

  if (waitSeconds !== null || /FLOOD_WAIT/i.test(message)) {
    return {
      type: 'rate_limit',
      method,
      message,
      code,
      attempt,
      retries,
      retryable: true,
      waitSeconds,
    };
  }

  if (looksLikeValidationError(message, code)) {
    return { type: 'validation', method, message, code, attempt, retries, retryable: false };
  }

  if (looksLikeTimeoutError(message, code)) {
    const normalizedCode = code ? String(code).toUpperCase() : '';
    return {
      type: 'timeout', method, message, code, attempt, retries,
      retryable: normalizedCode
        ? RETRYABLE_TIMEOUT_CODES.has(normalizedCode)
        : message.toLowerCase() !== 'timeout',
    };
  }

  if (looksLikeRetryableNetworkError(message, code)) {
    return { type: 'network', method, message, code, attempt, retries, retryable: true };
  }

  if (looksLikeTransportError(message, error)) {
    return { type: 'network', method, message, code, attempt, retries, retryable: true };
  }

  if (looksLikeTelegramError(message, code, error)) {
    return { type: 'telegram', method, message, code, attempt, retries, retryable: false };
  }

  return { type: 'unknown', method, message, code, attempt, retries, retryable: false };
}

/**
 * Execute a send function with configurable retries, backoff, and timeout.
 *
 * Options:
 *   retries      — max retry count (default 0)
 *   method       — method name for error details (default 'sendMedia')
 *   retryBackoff — parsed backoff config from parseRetryBackoff()
 *   maxWaitSeconds — max FLOOD_WAIT to honor in seconds (default 300)
 *   timeoutMs    — total time budget in ms (optional)
 *   onRetry      — callback on each retry (optional)
 *   sleep        — sleep function for testing (default: setTimeout)
 *   now          — clock function for testing (default: Date.now)
 */
export async function executeSendWithRetries(sendFn, options = {}) {
  const retries = Number.isInteger(options.retries) && options.retries >= 0 ? options.retries : 0;
  const method = options.method ?? 'sendMedia';
  const backoff = parseRetryBackoff(options.retryBackoff);
  const maxWaitSeconds = Number.isFinite(options.maxWaitSeconds) && options.maxWaitSeconds >= 0
    ? options.maxWaitSeconds
    : 300;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadlineAt = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? now() + options.timeoutMs
    : null;

  function remainingMs() {
    return deadlineAt !== null ? deadlineAt - now() : null;
  }

  function timeoutDetails(attemptNum) {
    return { type: 'timeout', method, message: 'Timeout', code: null, attempt: attemptNum, retries, retryable: false };
  }

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const remaining = remainingMs();
    if (remaining !== null && remaining <= 0) {
      throw new SendCommandError(timeoutDetails(Math.max(1, attempt - 1)));
    }

    try {
      const result = await sendFn({ attempt });
      return { result, attempts: attempt };
    } catch (error) {
      const details = classifySendError(error, { method, attempt, retries });
      const waitSeconds = Number.isFinite(details.waitSeconds) ? details.waitSeconds : null;
      const exceedsMaxWait = details.type === 'rate_limit'
        && waitSeconds !== null
        && waitSeconds > maxWaitSeconds;
      const shouldRetry = details.retryable && attempt <= retries && !exceedsMaxWait;
      if (!shouldRetry) {
        throw new SendCommandError(details);
      }

      // Fire onRetry callback (swallow non-programmer errors)
      if (typeof options.onRetry === 'function') {
        try {
          options.onRetry(details);
        } catch (callbackError) {
          if (callbackError instanceof TypeError || callbackError instanceof ReferenceError) {
            throw callbackError;
          }
          console.error('[executeSendWithRetries] onRetry callback error:', callbackError);
        }
      }

      const retryDelayMs = details.type === 'rate_limit' && waitSeconds !== null
        ? waitSeconds * 1000
        : getRetryDelayMs(backoff, attempt);

      if (deadlineAt !== null) {
        const left = remainingMs();
        if (left <= 0) {
          throw new SendCommandError(timeoutDetails(attempt));
        }
        // A Telegram-imposed FLOOD_WAIT that exceeds the remaining timeout budget
        // is a deliberate rate limit, not a hung connection. Abort early with the
        // rate-limit reason instead of sleeping into a generic timeout.
        if (details.type === 'rate_limit' && waitSeconds !== null && retryDelayMs > left) {
          throw new SendCommandError({
            ...details,
            retryable: false,
            message: formatRateLimitTimeoutMessage(waitSeconds, options.timeoutMs),
          });
        }
        if (retryDelayMs > 0) {
          await sleep(Math.min(retryDelayMs, left));
          if (remainingMs() <= 0) {
            throw new SendCommandError(timeoutDetails(attempt));
          }
        }
      } else if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }

  // Safety net — should be unreachable
  throw new SendCommandError(timeoutDetails(retries + 1));
}

/**
 * Build a structured JSON success payload for send results.
 */
export function buildSendSuccessPayload({ method, chatId, messageId, media, attempts, warning }) {
  const payload = {
    ok: true,
    method,
    chat_id: chatId,
    message_id: messageId,
    attempts,
  };

  if (media && typeof media === 'object') {
    const mediaPayload = {};
    if (media.type) mediaPayload.type = media.type;
    if (media.fileId) mediaPayload.file_id = media.fileId;
    if (Object.keys(mediaPayload).length > 0) {
      payload.media = mediaPayload;
    }
  }

  if (warning) {
    payload.warning = warning;
  }

  return payload;
}

/**
 * Build a structured JSON error payload for send failures.
 */
export function buildSendErrorPayload(details = {}) {
  const payload = {
    ok: false,
    error: {
      type: details.type ?? 'unknown',
      method: details.method ?? 'sendMedia',
      message: details.message ?? 'Unknown error',
      attempt: details.attempt ?? 1,
      retries: details.retries ?? 0,
    },
  };

  if (details.code !== undefined && details.code !== null && details.code !== '') {
    payload.error.code = details.code;
  }

  return payload;
}

/**
 * Format send error details into a human-readable string.
 */
export function formatSendErrorMessage(details = {}) {
  const attempt = details.attempt ?? 1;
  const retries = details.retries ?? 0;
  const totalAttempts = retries + 1;
  const codeSuffix = details.code !== undefined && details.code !== null && details.code !== ''
    ? `, code ${details.code}`
    : '';
  return `${details.method ?? 'sendMedia'} failed [${details.type ?? 'unknown'}]: ${details.message ?? 'Unknown error'} (attempt ${attempt}/${totalAttempts}${codeSuffix})`;
}

export function classifyError(error, context = {}) {
  return classifySendError(error, context);
}

export function computeRetryWaitSeconds(error, attempt) {
  const requiredWaitSeconds = parseRequiredWaitSeconds(error);
  if (requiredWaitSeconds !== null) {
    return requiredWaitSeconds;
  }

  return getRetryDelayMs({ kind: 'exponential', baseMs: 1000 }, attempt) / 1000;
}
