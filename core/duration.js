// Shared duration parser used by the CLI (cli.js) and the background server
// (mcp-server.js). Returns the duration in milliseconds.
//
// Accepts a string with an optional unit suffix: ms | s | m | h. A bare number
// is interpreted as SECONDS (e.g. "30" -> 30000), matching long-standing CLI
// behavior. Returns null for empty/non-string input; throws on an unparseable
// value.
export function parseDuration(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const raw = value.trim();
  const match = raw.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  if (unit === 'ms') return amount;
  if (unit === 's') return amount * 1000;
  if (unit === 'm') return amount * 60 * 1000;
  if (unit === 'h') return amount * 60 * 60 * 1000;
  return amount * 1000;
}
