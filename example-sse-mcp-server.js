import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";

// Create Express app
const app = express();
const PORT = process.env.PORT || 8808;

// Initialize MCP Server
const server = new Server(
  { 
    name: "simple-mcp-server", 
    version: "1.0.0" 
  },
  { 
    capabilities: {
      tools: {},
    }
  }
);

// Set up tool listing handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "random",
        description: "Returns a random number between 0 and 1",
        inputSchema: {
          type: "object",
          properties: {
            min: {
              type: "number",
              description: "Minimum value"
            },
            max: {
              type: "number",
              description: "Maximum value"
            }
          }
        }
      }
    ]
  };
});

// Set up tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.log("--> Received tool call:", request);
  try {
    const toolName = request.params.name;
    
    if (toolName === "random") {
      const min = request.params.arguments?.min || 0;
      const max = request.params.arguments?.max || 1;
      const randomNumber = Math.random() * (max - min) + min;
      return {
        content: [
          { 
            type: "text", 
            text: `${randomNumber}`
          }
        ],
        isError: false
      };
    } else {
      throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (err) {
    console.error(err);
    throw err;
  }
});

// Run the MCP Server
async function runMCPServer() {
  let transport;

  // Set up SSE endpoint
  app.get("/sse", async (req, res) => {
    try {
    console.log("--> Received SSE connection:", req.url);
    transport = new SSEServerTransport("/message", res);
    console.log("New SSE connection established");
    
    await server.connect(transport);
    
    const originalOnMessage = transport.onmessage;
    const originalOnClose = transport.onclose;
    const originalOnError = transport.onerror;
    
    transport.onmessage = (msg) => {
      console.log("Received message:", msg);
      if (originalOnMessage) originalOnMessage(msg);
    };
    
    transport.onclose = () => {
      console.log("Transport closed");
      if (originalOnClose) originalOnClose();
    };
    
    transport.onerror = (err) => {
      console.error("Transport error:", err);
      if (originalOnError) originalOnError(err);
    };
    
    server.onclose = async () => {
      await server.close();
      console.log("SSE connection closed");
    };
} catch (err) {
  console.error("Error setting up SSE endpoint:", err);
  res.status(500).send("Server error: failed to setup SSE endpoint");
}
  });
  
  // Set up message endpoint for POST requests
  app.post("/message", async (req, res) => {
    console.log("--> Received message (POST)");
    if (transport?.handlePostMessage) {
      await transport.handlePostMessage(req, res);
    } else {
      console.error("transport.handlePostMessage is undefined!");
      res.status(500).send("Server error: transport not initialized");
    }
    console.log("<--", res.statusCode, res.statusMessage);
  });
  
  // Start the server
  app.listen(PORT, () => {
    console.log(`MCP Server is running on port ${PORT}`);
    console.log(`Connect to SSE endpoint at http://localhost:${PORT}/sse`);
  });
}

// Start the server and handle any errors
runMCPServer().catch(console.error);
