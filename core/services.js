import path from 'path';

import TelegramClient from '../telegram-client.js';
import MessageSyncService from '../message-sync-service.js';
import { loadConfig, normalizeConfig, validateConfig } from './config.js';
import { resolveStorePaths } from './store.js';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_INTER_JOB_DELAY_MS = 3000;
const DEFAULT_INTER_BATCH_DELAY_MS = 1200;

function resolveRuntimePaths(options = {}) {
  const resolvedStoreDir = options.storeDir ? path.resolve(options.storeDir) : null;
  if (!resolvedStoreDir && (!options.sessionPath || !options.dbPath)) {
    throw new Error('storeDir is required when sessionPath or dbPath are not provided.');
  }

  const paths = resolvedStoreDir ? resolveStorePaths(resolvedStoreDir) : {};
  const sessionPath = options.sessionPath ?? paths.sessionPath;
  const dbPath = options.dbPath ?? paths.dbPath;

  if (!sessionPath || !dbPath) {
    throw new Error('sessionPath and dbPath are required.');
  }

  return {
    resolvedStoreDir,
    sessionPath,
    dbPath,
  };
}

export function resolveValidatedConfig(options = {}, resolvedStoreDir = null) {
  const loadedConfig = options.config ?? (resolvedStoreDir ? loadConfig(resolvedStoreDir).config : null);
  const config = normalizeConfig(loadedConfig ?? {});
  const missing = validateConfig(config);
  if (missing.length > 0) {
    throw new Error('Missing tgcli configuration. Run "tgcli auth" to set credentials.');
  }

  return config;
}

export function createTelegramClient(options = {}) {
  const { resolvedStoreDir, sessionPath } = resolveRuntimePaths(options);
  const config = resolveValidatedConfig(options, resolvedStoreDir);

  const telegramClient = new TelegramClient(
    config.apiId,
    config.apiHash,
    config.phoneNumber,
    sessionPath,
    {
      forceSms: options.forceSms ?? false,
      useQr: options.useQr ?? false,
      qrFilePath: options.qrFilePath ?? null,
      json: options.json ?? false,
      disableUpdates: options.disableUpdates ?? false,
    },
  );

  return {
    storeDir: resolvedStoreDir,
    sessionPath,
    config,
    telegramClient,
  };
}

export function createMessageSyncService(telegramClient, options = {}) {
  const { resolvedStoreDir, dbPath } = resolveRuntimePaths(options);
  const messageSyncService = new MessageSyncService(telegramClient, {
    dbPath,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    interJobDelayMs: options.interJobDelayMs ?? DEFAULT_INTER_JOB_DELAY_MS,
    interBatchDelayMs: options.interBatchDelayMs ?? DEFAULT_INTER_BATCH_DELAY_MS,
  });

  return {
    storeDir: resolvedStoreDir,
    dbPath,
    messageSyncService,
  };
}

export function createServices(options = {}) {
  const { resolvedStoreDir, sessionPath, dbPath } = resolveRuntimePaths(options);
  const config = resolveValidatedConfig(options, resolvedStoreDir);
  const { telegramClient } = createTelegramClient({
    ...options,
    storeDir: resolvedStoreDir,
    sessionPath,
    dbPath,
    config,
  });

  const { messageSyncService } = createMessageSyncService(telegramClient, {
    ...options,
    storeDir: resolvedStoreDir,
    sessionPath,
    dbPath,
  });

  return {
    storeDir: resolvedStoreDir,
    sessionPath,
    dbPath,
    config,
    telegramClient,
    messageSyncService,
  };
}
