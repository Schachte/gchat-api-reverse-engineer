/**
 * Google Chat API Client - Cookie-based Auth
 * 
 * Uses browser cookies to authenticate with Google Chat's internal API.
 * This matches how purple-googlechat's XSRF token auth works.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { loadTokens, generateSapisidHash, parseCookieString } from './auth-cookie.js';

// Can use either chat.google.com or mail.google.com/chat
const CHAT_API_BASE = 'https://mail.google.com';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Target space ID from user
const TARGET_SPACE_ID = process.env.SPACE_ID || 'AAAAHKvY2CQ';

class GoogleChatClient {
  constructor(tokens) {
    this.tokens = tokens;
    this.cookies = tokens.cookies;
    this.xsrfToken = tokens.xsrf_token;
    this.sapisid = tokens.sapisid;
  }

  /**
   * Generate authorization header for API requests
   */
  getAuthHeaders() {
    const headers = {
      'Cookie': this.cookies,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Origin': 'https://chat.google.com',
      'Referer': 'https://chat.google.com/',
      'X-Goog-Authuser': '0',
    };

    // Add SAPISIDHASH if we have SAPISID
    if (this.sapisid) {
      headers['Authorization'] = generateSapisidHash(this.sapisid);
    }

    return headers;
  }

  /**
   * Make a batchexecute API request (Google's internal RPC format)
   */
  async batchExecute(rpcId, requestData) {
    const url = `${CHAT_API_BASE}/_/DynamiteWebUi/data/batchexecute`;
    
    // Google's batchexecute format
    const rpcRequest = JSON.stringify([
      [
        [rpcId, JSON.stringify(requestData), null, "generic"]
      ]
    ]);

    const body = new URLSearchParams({
      'f.req': rpcRequest,
      'at': this.xsrfToken,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed (${response.status}): ${text.substring(0, 500)}`);
    }

    const text = await response.text();
    return this.parseBatchResponse(text);
  }

  /**
   * Parse Google's batchexecute response format
   */
  parseBatchResponse(text) {
    // Remove XSSI protection prefix
    const cleaned = text.replace(/^\)\]\}'/, '').trim();
    
    // The response is multiple JSON arrays, one per line
    const lines = cleaned.split('\n').filter(l => l.trim());
    
    const results = [];
    for (const line of lines) {
      try {
        // Try to parse as length-prefixed data
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) {
          results.push(parsed);
        }
      } catch (e) {
        // Skip non-JSON lines (length prefixes)
        continue;
      }
    }

    // Extract the actual response data
    for (const result of results) {
      if (Array.isArray(result) && result[0] && Array.isArray(result[0])) {
        const innerArray = result[0];
        // Find the response data (usually at index 2)
        for (const item of innerArray) {
          if (Array.isArray(item) && item.length >= 3 && typeof item[2] === 'string') {
            try {
              return JSON.parse(item[2]);
            } catch (e) {
              continue;
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Alternative: Direct protobuf-style API
   */
  async apiRequest(endpoint, requestBody) {
    const url = `${CHAT_API_BASE}/u/0${endpoint}`;
    
    const headers = {
      ...this.getAuthHeaders(),
      'Content-Type': 'application/x-protobuf',
    };

    // Build query params
    const params = new URLSearchParams({
      'rt': 'j',  // Response type: JSON
      'pt': 'true',
    });

    const response = await fetch(`${url}?${params}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed (${response.status}): ${text.substring(0, 500)}`);
    }

    const text = await response.text();
    // Remove XSSI protection
    const jsonStr = text.replace(/^\)\]\}'/, '').trim();
    
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      return text;
    }
  }

  /**
   * Get messages from a specific space using the web API format
   */
  async getSpaceMessages(spaceId, pageSize = 25) {
    // RPC ID for listing topics/messages
    const rpcId = 'MJJSQe';  // ListTopics RPC
    
    // Request format matches the protobuf structure
    const request = [
      null,  // RequestHeader placeholder
      pageSize,  // page_size_for_topics
      10,  // page_size_for_replies
      null,
      null,
      5,  // page_size_for_unread_replies  
      5,  // page_size_for_read_replies
      [   // group_id
        [spaceId],  // space_id
        null        // dm_id
      ]
    ];

    return this.batchExecute(rpcId, request);
  }

  /**
   * Get space/group info
   */
  async getSpaceInfo(spaceId) {
    const rpcId = 'Xp7Hxe';  // GetGroup RPC
    
    const request = [
      null,
      [[spaceId], null]  // group_id with space_id
    ];

    return this.batchExecute(rpcId, request);
  }

  /**
   * List all spaces/conversations
   */
  async listSpaces() {
    const rpcId = 'ACcr7e';  // GetPaginatedWorld RPC (lists all spaces)
    
    const request = [
      null,  // RequestHeader
      50,    // page_size
      null,  // page_token
      1,     // include_spaces
      null,
      null,
      null,
      1      // include_dms
    ];

    return this.batchExecute(rpcId, request);
  }
}

/**
 * Extract messages from API response
 */
function extractMessages(response) {
  const messages = [];
  
  function traverse(obj, depth = 0) {
    if (!obj || depth > 15) return;
    
    if (Array.isArray(obj)) {
      // Look for message-like structures
      // Messages typically have: [message_id, ..., timestamp, ..., text_body, ...]
      if (obj.length > 10 && typeof obj[0] === 'string' && obj[0].length > 10) {
        // Check if this looks like a message
        const potentialText = obj.find(item => typeof item === 'string' && item.length > 0 && item.length < 10000);
        const potentialTimestamp = obj.find(item => typeof item === 'string' && /^\d{16,}$/.test(item));
        
        if (potentialText && potentialTimestamp) {
          messages.push({
            id: obj[0],
            text: potentialText,
            timestamp: potentialTimestamp
          });
        }
      }
      
      for (const item of obj) {
        traverse(item, depth + 1);
      }
    } else if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        traverse(obj[key], depth + 1);
      }
    }
  }
  
  traverse(response);
  return messages;
}

/**
 * Pretty print response data
 */
function prettyPrint(data, indent = 0) {
  const prefix = '  '.repeat(indent);
  
  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log(`${prefix}[]`);
      return;
    }
    
    // Check if it's a simple array
    const isSimple = data.every(item => 
      item === null || 
      typeof item === 'string' || 
      typeof item === 'number' || 
      typeof item === 'boolean'
    );
    
    if (isSimple && data.length <= 5) {
      console.log(`${prefix}${JSON.stringify(data)}`);
      return;
    }
    
    console.log(`${prefix}[`);
    data.forEach((item, i) => {
      if (i < 10 || i === data.length - 1) {
        prettyPrint(item, indent + 1);
      } else if (i === 10) {
        console.log(`${prefix}  ... (${data.length - 10} more items)`);
      }
    });
    console.log(`${prefix}]`);
  } else if (data && typeof data === 'object') {
    console.log(`${prefix}{`);
    Object.entries(data).slice(0, 10).forEach(([key, value]) => {
      process.stdout.write(`${prefix}  "${key}": `);
      prettyPrint(value, indent + 1);
    });
    console.log(`${prefix}}`);
  } else {
    const str = JSON.stringify(data);
    if (str && str.length > 100) {
      console.log(`${prefix}${str.substring(0, 100)}...`);
    } else {
      console.log(`${prefix}${str}`);
    }
  }
}

/**
 * Main function
 */
async function main() {
  console.log('=== Google Chat Message Fetcher (Cookie Auth) ===\n');

  // Load tokens
  const tokens = loadTokens();
  
  if (!tokens || tokens.auth_type !== 'cookie') {
    console.error('No cookie-based tokens found.');
    console.error('Run: node auth-cookie.js');
    process.exit(1);
  }

  console.log('Using cookie-based authentication');
  console.log(`XSRF Token: ${tokens.xsrf_token?.substring(0, 20)}...`);
  console.log(`Target Space: ${TARGET_SPACE_ID}\n`);

  const client = new GoogleChatClient(tokens);

  // First, try to get space info
  console.log('--- Fetching Space Info ---\n');
  try {
    const spaceInfo = await client.getSpaceInfo(TARGET_SPACE_ID);
    console.log('Space info response:');
    prettyPrint(spaceInfo);
  } catch (e) {
    console.error('Error fetching space info:', e.message);
  }

  // Fetch messages from the target space
  console.log('\n--- Fetching Messages ---\n');
  try {
    const response = await client.getSpaceMessages(TARGET_SPACE_ID, 20);
    
    console.log('Raw response structure:');
    prettyPrint(response);
    
    // Try to extract messages
    const messages = extractMessages(response);
    if (messages.length > 0) {
      console.log(`\nExtracted ${messages.length} message(s):`);
      messages.forEach((msg, i) => {
        const date = msg.timestamp ? new Date(parseInt(msg.timestamp) / 1000) : null;
        console.log(`\n[${i + 1}] ${date?.toLocaleString() || 'Unknown time'}`);
        console.log(`    ${msg.text?.substring(0, 200) || '(no text)'}`);
      });
    }
    
  } catch (e) {
    console.error('Error fetching messages:', e.message);
    console.error('\nThis might mean:');
    console.error('1. The space ID is incorrect');
    console.error('2. You don\'t have access to this space');
    console.error('3. The cookies have expired (re-run auth-cookie.js)');
    console.error('4. The API format has changed');
  }

  // Also try listing all spaces to help debug
  console.log('\n--- Listing Your Spaces ---\n');
  try {
    const spaces = await client.listSpaces();
    console.log('Spaces response:');
    prettyPrint(spaces);
  } catch (e) {
    console.error('Error listing spaces:', e.message);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
