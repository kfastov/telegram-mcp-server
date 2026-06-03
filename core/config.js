import fs from 'fs';
import path from 'path';

import { resolveStoreDir } from './store.js';

const CONFIG_FILE = 'config.json';

function normalizeValue(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return String(value).trim();
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

export function normalizeConfig(raw = {}) {
  const apiId = normalizeValue(raw.apiId ?? raw.api_id ?? raw.apiID);
  const apiHash = normalizeValue(raw.apiHash ?? raw.api_hash);
  const phoneNumber = normalizeValue(raw.phoneNumber ?? raw.phone ?? raw.phone_number);
  const mcpRaw = raw.mcp && typeof raw.mcp === 'object' ? raw.mcp : {};
  const controlRaw = raw.control && typeof raw.control === 'object' ? raw.control : {};
  const feedbackRaw = raw.feedback && typeof raw.feedback === 'object' ? raw.feedback : {};
  const mcpEnabled = normalizeBoolean(raw.mcpEnabled ?? raw.mcp_enabled ?? mcpRaw.enabled, false);
  const mcp = {
    enabled: mcpEnabled,
  };
  const mcpHost = normalizeValue(mcpRaw.host ?? raw.mcpHost ?? raw.mcp_host);
  if (mcpHost) {
    mcp.host = mcpHost;
  }
  const mcpPortRaw = mcpRaw.port ?? raw.mcpPort ?? raw.mcp_port;
  const mcpPort = Number(mcpPortRaw);
  if (Number.isFinite(mcpPort) && mcpPort > 0) {
    mcp.port = mcpPort;
  }
  // Loopback control API: always-on (default enabled) and independent of mcp.*.
  const controlEnabled = normalizeBoolean(
    raw.controlEnabled ?? raw.control_enabled ?? controlRaw.enabled,
    true,
  );
  const control = {
    enabled: controlEnabled,
  };
  const controlHost = normalizeValue(controlRaw.host ?? raw.controlHost ?? raw.control_host);
  control.host = controlHost || '127.0.0.1';
  const controlPortRaw = controlRaw.port ?? raw.controlPort ?? raw.control_port;
  const controlPort = Number(controlPortRaw);
  control.port = Number.isFinite(controlPort) && controlPort > 0 ? controlPort : 8765;
  const feedbackChatId = normalizeValue(
    feedbackRaw.chatId ?? raw.feedbackChatId ?? raw.feedback_chat_id,
  );
  const normalized = {
    apiId,
    apiHash,
    phoneNumber,
    mcp,
    control,
  };
  if (feedbackChatId) {
    normalized.feedback = { chatId: feedbackChatId };
  }
  return normalized;
}

export function validateConfig(config) {
  const missing = [];
  if (!config?.apiId) missing.push('apiId');
  if (!config?.apiHash) missing.push('apiHash');
  if (!config?.phoneNumber) missing.push('phoneNumber');
  return missing;
}

export function resolveConfigPath(storeDir = resolveStoreDir()) {
  return path.join(storeDir, CONFIG_FILE);
}

export function loadConfig(storeDir = resolveStoreDir()) {
  const configPath = resolveConfigPath(storeDir);
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      config: normalizeConfig(parsed ?? {}),
      path: configPath,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { config: null, path: configPath };
    }
    throw error;
  }
}

export function saveConfig(storeDir = resolveStoreDir(), config) {
  const configPath = resolveConfigPath(storeDir);
  const payload = normalizeConfig(config ?? {});
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { config: payload, path: configPath };
}
