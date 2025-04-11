import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import mcpServer from './telegram-mcp.js';
import { debug } from './telegram-mcp.js';

// Create Express app
const app = express();
const PORT = process.env.PORT || 8080;

// Run the MCP Server with SSE transport
async function runMCPServer() {
  let transport;

  // Set up SSE endpoint
  app.get("/sse", async (req, res) => {
    try {
      debug('SSE', 'Received SSE connection request', req.url);
      
      // Set appropriate headers for SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // Create SSE transport
      transport = new SSEServerTransport("/message", res);
      debug('SSE', 'New SSE connection established');
      
      // Connect MCP server to the transport
      await mcpServer.connect(transport);
      
      // Add logging to transport events
      const originalOnMessage = transport.onmessage;
      const originalOnClose = transport.onclose;
      const originalOnError = transport.onerror;
      
      transport.onmessage = (msg) => {
        debug('SSE', 'Received message from client', msg);
        if (originalOnMessage) originalOnMessage(msg);
      };
      
      transport.onclose = () => {
        debug('SSE', 'Transport closed');
        if (originalOnClose) originalOnClose();
      };
      
      transport.onerror = (err) => {
        debug('SSE', 'Transport error', err);
        if (originalOnError) originalOnError(err);
      };
      
      // Handle client disconnect
      req.on('close', async () => {
        debug('SSE', 'Client disconnected, closing transport');
        if (transport) {
          await mcpServer.close();
          debug('SSE', 'MCP Server connection closed');
        }
      });
    } catch (err) {
      debug('SSE', 'Error setting up SSE endpoint', err);
      res.status(500).send("Server error: failed to setup SSE endpoint");
    }
  });
  
  // Set up message endpoint for POST requests
  app.post("/message", async (req, res) => {
    debug('SSE', 'Received message via POST');
    
    if (transport?.handlePostMessage) {
      await transport.handlePostMessage(req, res);
    } else {
      debug('SSE', 'Transport not initialized or handlePostMessage not available');
      res.status(500).send("Server error: transport not initialized");
    }
    
    debug('SSE', `Response sent with status: ${res.statusCode}`);
  });
  
  // Start the Express server
  app.listen(PORT, () => {
    debug('SSE', `Telegram MCP Server is running with SSE transport on port ${PORT}`);
    debug('SSE', `Connect to SSE endpoint at http://localhost:${PORT}/sse`);
  });
}

// Start the server and handle any errors
runMCPServer().catch(err => {
  debug('SSE', 'Fatal error starting server', err);
}); 