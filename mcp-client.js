import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import fetch from "node-fetch";

const SERVER_URL = "http://localhost:8808/sse";

async function main() {
  try {
    console.log("Connecting to MCP server...");
    
    // Create the SSE transport for communication
    const transport = new SSEClientTransport(new URL(SERVER_URL));
    
    if (!transport) {
      console.error("Failed to create SSE transport");
      process.exit(1);
    }

    // Create the MCP client
    const client = new Client({
        name: "MCP Client",
        version: "1.0.0",        
    });
    
    // Connect to the server
    await client.connect(transport);
    console.log("Connected to MCP server successfully!");
    
    // List available tools (optional, but good to verify)
    const tools = await client.listTools();
    console.log("Available tools:", JSON.stringify(tools, null, 2));
    
    // Call the "hello" tool with a hardcoded argument
    console.log(`Calling random tool with min: 0 and max: 10...`);
    
    const result = await client.callTool({
        name: "random",
        arguments: { min: 0, max: 10 },
    });
    console.log("Tool response:", result);
    
    // Close the connection
    await client.close();
    console.log("Connection closed");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

// Run the client
main().catch(console.error); 