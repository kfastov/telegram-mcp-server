// Vocabulary shared between the client layer's peer resolution hints and the
// frontends that restate them. The client appends frontend-neutral hints to
// resolution errors (it backs the CLI, the MCP server, and the control API,
// so no flag or command syntax belongs there); a frontend recognizes the
// sign-retry suggestion via PEER_SIGN_RETRY_PATTERN and rephrases it in its
// own argument vocabulary. Kept dependency-free so frontends can import it
// without pulling in the client module.

// The neutral suggestion appended when a bare positive group/channel id fails
// to resolve in any sign form.
export function peerSignRetryHint(positiveId) {
  return `group and channel ids are negative — retry with the negative id "-${positiveId}"`;
}

// Matches the peerSignRetryHint phrasing, capturing the suggested negative id.
export const PEER_SIGN_RETRY_PATTERN = /retry with the negative id "(-\d+)"/;
