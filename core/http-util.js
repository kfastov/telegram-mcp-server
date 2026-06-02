// Small shared helpers for the loopback control listener (core/control-server.js)
// and the MCP HTTP listener (mcp-server.js). Both read a JSON request body the
// same way; keep one implementation so they cannot drift.

// Reads the full request body and parses it as JSON. Resolves to {} for an
// empty body; rejects on invalid JSON.
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req
      .on('data', (chunk) => chunks.push(chunk))
      .on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(raw.length ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      })
      .on('error', (error) => reject(error));
  });
}

// Writes a JSON response with the given status code.
export function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
}
