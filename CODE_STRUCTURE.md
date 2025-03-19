# Code Structure

The Telegram MCP server is structured in a modular way for improved maintainability and separation of concerns. This document explains how the code is organized and how the different components interact.

## Overview

The codebase is divided into three main files:

1. **mcp-server.js** - The main entry point
2. **telegram-mcp.js** - MCP server definition and Telegram tools
3. **http-server.js** - HTTP and SSE implementation

## Detailed Component Breakdown

### mcp-server.js

This is the entry point file. It's a minimal wrapper that:

- Imports the HTTP server implementation
- Logs initial startup message
- Acts as the main execution point (the file you run via `npm start`)

```javascript
// This is the main entry point for the MCP server.
// It simply imports the HTTP server module which sets up and runs everything.

import "./http-server.js";

console.log("Starting Telegram MCP server...");
```

### telegram-mcp.js

This file contains the core MCP server implementation and all Telegram-related functionality:

1. **MCP Server Definition**: Creates and configures the MCP server instance
2. **Debug Utility**: Exports a debug function for logging
3. **Telegram Client**: Initializes and manages the Telegram client
4. **Authentication**: Handles Telegram login and session management
5. **MCP Tools**: Defines all the tools available to LLMs:
   - `searchChannels`: Search for channels matching keywords
   - `getChannelMessages`: Get messages from a specific channel
   - `listChannels`: List all available channels

All Telegram-specific logic is encapsulated in this file, making it easy to update Telegram functionality without touching the HTTP/transport layer.

Key exports:

- Default export: The configured MCP server instance
- Named export: `debug` function for logging

### http-server.js

This file handles all HTTP and SSE transport functionality:

1. **Express Setup**: Configures the Express.js server and middleware
2. **Logging Middleware**: Logs all HTTP requests and responses
3. **LoggingSSETransport**: Custom transport class for logging MCP messages
4. **SSE Implementation**: Sets up SSE endpoint and message handling
5. **Error Handling**: Provides error handling middleware
6. **Server Startup**: Starts the HTTP server on the configured port

The transport layer is completely separate from the MCP functionality, allowing for different transport methods to be implemented without changing the MCP tools.

## Communication Flow

1. **Client Connection**:

   - Client connects to `/sse` endpoint
   - Server creates a LoggingSSETransport and connects it to the MCP server
   - SSE connection is established

2. **Client Messages**:

   - Client sends messages to `/messages` endpoint
   - Server forwards the message to the transport
   - Transport passes the message to the MCP server
   - MCP server processes the message and invokes the appropriate tool
   - Response is sent back through the transport via SSE

3. **Error Handling**:
   - HTTP errors are caught by Express middleware
   - Client disconnections are detected and cleaned up
   - MCP errors are logged and returned to the client

## Benefits of This Architecture

1. **Modularity**: Each component has a single responsibility
2. **Maintainability**: Changes to one area don't affect others
3. **Extensibility**: Easy to add new tools or change transport methods
4. **Testability**: Components can be tested in isolation
5. **Clarity**: Clear separation makes the code easier to understand

## Future Improvements

Potential improvements to this architecture could include:

1. **Multi-client Support**: Enhance the HTTP server to manage multiple simultaneous clients
2. **Configuration System**: Move hardcoded settings to a config file
3. **Plugin System**: Allow for dynamically loading additional MCP tools
4. **Alternative Transports**: Add support for WebSockets or other transport methods
