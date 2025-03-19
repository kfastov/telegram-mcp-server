# Building an SSE-based MCP Server in Node.js

## What is MCP?

The **Model Context Protocol (MCP)** is a standardized protocol that allows applications to provide context for Large Language Models (LLMs). MCP enables seamless integration between LLM applications and external data sources or tools.

Key concepts in MCP:

- **Resources**: Provide data to LLMs (similar to GET endpoints in REST APIs)
- **Tools**: Allow LLMs to take actions through your server (similar to POST endpoints)
- **Prompts**: Define reusable templates for LLM interactions

## What is SSE?

**Server-Sent Events (SSE)** is a technology that allows a server to push updates to clients over a single HTTP connection. Unlike WebSockets, SSE is unidirectional (server-to-client only) and works over standard HTTP, making it simpler to implement and maintain.

## Why Use SSE for MCP?

SSE is an ideal transport mechanism for MCP because:

1. It provides a continuous connection for real-time updates
2. It's based on standard HTTP, requiring less complex infrastructure
3. It has built-in reconnection handling
4. It's well-supported across modern browsers and Node.js

## Setting up an SSE MCP Server

### Prerequisites

- Node.js installed (version 14+ recommended)
- npm or yarn for package management

### Step 1: Set up your project

```bash
mkdir mcp-server
cd mcp-server
npm init -y
npm install @modelcontextprotocol/sdk express
```

### Step 2: Create the basic server

Create a file named `server.js`:

```javascript
const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");

const app = express();
const PORT = process.env.PORT || 3000;

// Create the MCP server
const mcpServer = new McpServer({
  name: "My MCP Server",
  version: "1.0.0",
});

// Set up SSE endpoint
app.get("/sse", async (req, res) => {
  // Set headers for SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial endpoint event
  const sessionId = generateSessionId();
  res.write(`event: endpoint\ndata: /sse/messages?session_id=${sessionId}\n\n`);

  // Keep the connection alive with periodic pings
  const pingInterval = setInterval(() => {
    res.write(`: ping - ${new Date().toISOString()}\n\n`);
  }, 30000);

  // Handle client disconnect
  req.on("close", () => {
    clearInterval(pingInterval);
    res.end();
  });
});

// JSON-RPC endpoint for MCP messages
app.post("/sse/messages", express.json(), async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;

  if (jsonrpc !== "2.0") {
    return res.status(400).json({ error: "Invalid JSON-RPC request" });
  }

  // Handle MCP methods
  let response;
  try {
    switch (method) {
      case "initialize":
        response = await handleInitialize(id, params);
        break;
      case "listTools":
        response = await handleListTools(id);
        break;
      case "callTool":
        response = await handleCallTool(id, params);
        break;
      // Add other method handlers as needed
      default:
        response = {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
    res.json(response);
  } catch (error) {
    res.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error.message,
      },
    });
  }
});

// Sample method handlers
async function handleInitialize(id, params) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: params.protocolVersion,
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
        logging: true,
        roots: { listChanged: true },
        sampling: true,
      },
      serverInfo: {
        name: "My MCP Server",
        version: "1.0.0",
      },
      tools: [
        {
          name: "uppercase",
          description: "Convert text to uppercase",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", description: "Text to convert" },
            },
            required: ["text"],
          },
        },
      ],
    },
  };
}

async function handleListTools(id) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      tools: [
        {
          name: "uppercase",
          description: "Convert text to uppercase",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", description: "Text to convert" },
            },
            required: ["text"],
          },
        },
      ],
    },
  };
}

async function handleCallTool(id, params) {
  const { name, arguments: args } = params;

  if (name === "uppercase") {
    const result = args.text.toUpperCase();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32602,
      message: `Tool not found: ${name}`,
    },
  };
}

// Helper function to generate a session ID
function generateSessionId() {
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

// Start the server
app.listen(PORT, () => {
  console.log(`MCP SSE server running on port ${PORT}`);
});
```

### Step 3: Add resources to your MCP server

Extend your server with resource support:

```javascript
// Add this to your imports
const { ResourceTemplate } = require("@modelcontextprotocol/sdk/server/mcp.js");

// Add this before app.listen
app.post("/sse/messages", express.json(), async (req, res) => {
  // ...existing code...

  switch (method) {
    // ...existing cases...
    case "fetchResource":
      response = await handleFetchResource(id, params);
      break;
  }

  // ...rest of the function...
});

async function handleFetchResource(id, params) {
  const { uri } = params;

  if (uri.startsWith("docs://")) {
    // Extract resource ID from URI
    const resourceId = uri.replace("docs://", "");

    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [
          {
            uri: uri,
            text: `This is the content of document ${resourceId}`,
          },
        ],
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32602,
      message: `Resource not found: ${uri}`,
    },
  };
}
```

## Using the Type-Safe SDK Approach

For a more type-safe approach utilizing the full MCP SDK:

```javascript
const express = require("express");
const {
  McpServer,
  ResourceTemplate,
} = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  SseServerTransport,
} = require("@modelcontextprotocol/sdk/server/sse.js");
const { z } = require("zod");

const app = express();
const PORT = process.env.PORT || 3000;

// Create an MCP server
const server = new McpServer({
  name: "TypeSafe MCP Server",
  version: "1.0.0",
});

// Add a tool
server.tool(
  "uppercase",
  { text: z.string().describe("Text to convert to uppercase") },
  async ({ text }) => ({
    content: [{ type: "text", text: text.toUpperCase() }],
  })
);

// Add a resource
server.resource(
  "document",
  new ResourceTemplate("docs://{docId}", { list: undefined }),
  async (uri, { docId }) => ({
    contents: [
      {
        uri: uri.href,
        text: `This is document ${docId} content`,
      },
    ],
  })
);

// SSE endpoint
app.get("/sse", async (req, res) => {
  const transport = new SseServerTransport("/sse/messages");
  await transport.handleRequest(req, res);
  await server.connect(transport);
});

// Start the server
app.listen(PORT, () => {
  console.log(`TypeSafe MCP SSE server running on port ${PORT}`);
});
```

## Testing Your MCP Server

You can test your MCP server using:

1. The MCP Inspector tool available at [modelcontextprotocol.io](https://modelcontextprotocol.io)
2. Claude or other MCP-compatible AI assistants
3. The MCP gateway for compatibility with stdio-based clients

## Advanced Features

- **Error Handling**: Add robust error handling and logging
- **Authentication**: Protect your MCP server with JWT or other auth methods
- **Session Management**: Track client sessions and state
- **Caching**: Cache resource responses for performance
- **Monitoring**: Add metrics to track usage and performance

## Conclusion

This guide provides a foundation for building an SSE-based MCP server in Node.js. The Model Context Protocol lets you create standardized interfaces for LLMs to interact with your data and services, while Server-Sent Events provides an efficient transport mechanism.

For a more complete implementation, refer to the official TypeScript SDK documentation and examples at [github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk).

## Modular Code Structure for MCP Servers

When building an MCP server, it's beneficial to adopt a modular structure that separates different concerns. Our implementation follows this pattern with three main components:

### 1. Entry Point (mcp-server.js)

A minimal entry point file that kicks off the application:

```javascript
// This is the main entry point for the MCP server.
// It simply imports the HTTP server module which sets up and runs everything.

import "./http-server.js";

console.log("Starting Telegram MCP server...");
```

### 2. MCP Server Definition (telegram-mcp.js)

This file contains the core MCP server implementation and tool definitions:

```javascript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Initialize MCP server
const server = new McpServer({
  name: "Example MCP Server",
  version: "1.0.0",
  description: "Example MCP server with modular structure",
});

// Define tools
server.tool("exampleTool", { param: z.string() }, async ({ param }) => {
  // Tool implementation...
  return { content: [{ type: "text", text: `Processed: ${param}` }] };
});

// Export the server for use in HTTP server
export default server;
```

### 3. Transport Layer (http-server.js)

This file handles the HTTP/SSE implementation:

```javascript
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import mcpServer from "./telegram-mcp.js";

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// Store the transport at module level
let transport;

// SSE endpoint
app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/messages", res);
  await mcpServer.connect(transport);

  // Handle client disconnect
  req.on("close", () => {
    transport = null;
  });
});

// Message endpoint
app.post("/messages", async (req, res) => {
  if (!transport) {
    return res.status(400).json({ error: "No active SSE connection" });
  }

  await transport.handlePostMessage(req, res);
});

// Start the server
app.listen(PORT, () => {
  console.log(`MCP server running on port ${PORT}`);
});
```

### Benefits of This Approach

1. **Separation of Concerns**: MCP tools are separate from transport logic
2. **Maintainability**: Easier to update one aspect without affecting others
3. **Reusability**: The MCP server can be connected to different transports
4. **Testability**: Components can be tested in isolation
5. **Clarity**: Code is more organized and easier to understand

For a complete view of this modular architecture, see the [CODE_STRUCTURE.md](CODE_STRUCTURE.md) document.
