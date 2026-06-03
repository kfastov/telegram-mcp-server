// Shared operation handlers: the single source of truth for read operations that
// both the CLI and the MCP tools expose. Each handler is a pure function of the
// services it needs plus its args, returning the structured data a caller renders.
//
// ctx is the warm-or-local service bundle: { telegramClient, messageSyncService }.
// The same handler runs whether a warm server serves the call (via
// /control/invoke) or the one-shot CLI runs it locally, so the result shape — and
// therefore the rendered output — is identical across both paths.
//
// OPERATIONS is a fixed allowlist: the control server dispatches only the keys
// present here.

// args: { query?: string, limit?: number }. With a query, search dialogs by title
// or username; otherwise list dialogs. Returns the dialog array as-is.
async function listChannels(ctx, args = {}) {
  const limit = args.limit ?? 50;
  if (args.query) {
    return ctx.telegramClient.searchDialogs(args.query, limit);
  }
  return ctx.telegramClient.listDialogs(limit);
}

// args: { chat: string|number }. Returns the primary invite-link descriptor for
// the group as the Telegram client reports it.
async function getGroupInviteLink(ctx, args = {}) {
  return ctx.telegramClient.getGroupInviteLink(args.chat);
}

export const OPERATIONS = {
  listChannels,
  getGroupInviteLink,
};
