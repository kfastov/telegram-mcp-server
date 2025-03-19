#!/usr/bin/env node

/**
 * This is a simple client that demonstrates how to make requests to the Telegram MCP server.
 * It can be used for testing and as an example of how to use the MCP API.
 */

import fetch from 'node-fetch';
import readline from 'readline';

const MCP_URL = 'http://localhost:3000/mcp/messages';

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function to ask questions
function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

// Function to make MCP API requests
async function mcpRequest(method, params = {}) {
  try {
    console.log(`\nSending request: ${method}`);
    console.log('Params:', JSON.stringify(params, null, 2));
    
    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 10000),
        method,
        params
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      console.error('Error:', data.error);
      return null;
    }
    
    console.log('\nResponse:');
    console.log(JSON.stringify(data.result, null, 2));
    
    return data.result;
  } catch (error) {
    console.error('Request failed:', error);
    return null;
  }
}

async function main() {
  console.log('Telegram MCP Client Example');
  console.log('==========================');
  
  try {
    while (true) {
      console.log('\nAvailable commands:');
      console.log('1. List channels');
      console.log('2. Search channels by keyword');
      console.log('3. Get messages from a channel');
      console.log('4. Exit');
      
      const choice = await askQuestion('\nEnter your choice (1-4): ');
      
      switch (choice) {
        case '1': {
          const limit = await askQuestion('Enter limit (default: 50): ') || 50;
          await mcpRequest('callTool', {
            name: 'listChannels',
            arguments: { limit: parseInt(limit) }
          });
          break;
        }
        
        case '2': {
          const keywords = await askQuestion('Enter keywords to search for: ');
          const limit = await askQuestion('Enter limit (default: 100): ') || 100;
          await mcpRequest('callTool', {
            name: 'searchChannels',
            arguments: { 
              keywords, 
              limit: parseInt(limit) 
            }
          });
          break;
        }
        
        case '3': {
          const channelId = await askQuestion('Enter channel ID: ');
          const limit = await askQuestion('Enter message limit (default: 100): ') || 100;
          const useFilter = await askQuestion('Apply filter pattern? (y/n): ');
          
          const params = { 
            channelId: parseInt(channelId), 
            limit: parseInt(limit) 
          };
          
          if (useFilter.toLowerCase() === 'y') {
            const filterPattern = await askQuestion('Enter regex filter pattern: ');
            params.filterPattern = filterPattern;
          }
          
          await mcpRequest('callTool', {
            name: 'getChannelMessages',
            arguments: params
          });
          break;
        }
        
        case '4':
          console.log('Exiting...');
          rl.close();
          return;
          
        default:
          console.log('Invalid choice. Please try again.');
      }
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    rl.close();
  }
}

main().catch(console.error); 