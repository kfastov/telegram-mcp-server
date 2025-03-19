import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import mcpServer, { debug } from './telegram-mcp.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON requests
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  debug('HTTP-IN', `${req.method} ${req.url}`, req.body);
  
  // Capture the response
  const originalSend = res.send;
  res.send = function(body) {
    debug('HTTP-OUT', `${res.statusCode} ${req.method} ${req.url}`, body);
    return originalSend.call(this, body);
  };
  
  next();
});

// Custom SSEServerTransport wrapper to log messages
class LoggingSSETransport extends SSEServerTransport {
  constructor(path, res) {
    super(path, res);
    debug('TRANSPORT', 'Created new SSE transport');
  }
  
  async sendMessage(message) {
    debug('MCP-OUT', 'Sending message to client', message);
    return super.sendMessage(message);
  }
  
  async handlePostMessage(req, res) {
    debug('MCP-IN', 'Received message from client', req.body);
    return super.handlePostMessage(req, res);
  }
}

// Minimal but WORKING SSE implementation
// Store the transport at module level so it's accessible to both handlers
let transport;

// SSE endpoint - establishes the event stream
app.get('/sse', async (req, res) => {
  debug('HTTP', 'New SSE connection request received');
  
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Create transport and connect it to the MCP server
  transport = new LoggingSSETransport('/messages', res);
  await mcpServer.connect(transport);
  debug('HTTP', 'SSE connection established');
  
  // Handle client disconnect
  req.on('close', () => {
    debug('HTTP', 'SSE connection closed by client');
    transport = null;
  });
});

// Message endpoint - for client to send messages to the server
app.post('/messages', async (req, res) => {
  debug('HTTP', 'Received message from client', req.body);
  
  // This only works for a single connection at a time
  if (!transport) {
    const error = 'No active SSE connection established';
    debug('HTTP', 'Error processing message', error);
    return res.status(400).json({ error });
  }
  
  try {
    await transport.handlePostMessage(req, res);
    debug('HTTP', 'Successfully processed client message');
  } catch (error) {
    debug('HTTP', 'Error processing client message', error);
    console.error('Message Processing Error:', error);
    return res.status(500).json({ error: 'Error processing message' });
  }
});

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', serverName: mcpServer.name });
});

// Error handling middleware
app.use((err, req, res, next) => {
  debug('ERROR', 'Express error', err);
  console.error('Server Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Telegram MCP server running on port ${PORT}`);
  debug('STARTUP', 'Server started successfully');
}); 