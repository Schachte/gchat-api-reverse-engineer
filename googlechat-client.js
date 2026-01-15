/**
 * Google Chat API Client - Using Dynamite Token Auth
 * 
 * Based on purple-googlechat implementation
 * Uses the Dynamite token obtained from OAuth flow
 */

import * as fs from 'fs';
import { ensureValidTokens, loadTokens, USER_AGENT } from './googlechat-auth.js';

const TARGET_SPACE_ID = process.env.SPACE_ID || 'AAAAHKvY2CQ';

// API endpoints
const CHAT_API_BASE = 'https://chat.google.com';

class GoogleChatClient {
  constructor(tokens) {
    this.tokens = tokens;
    this.dynamiteToken = tokens.dynamite_token;
    this.accessToken = tokens.access_token;
  }

  /**
   * Get headers for API requests using Dynamite token
   */
  getHeaders() {
    return {
      'Authorization': `Bearer ${this.dynamiteToken}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': USER_AGENT,
      'Origin': CHAT_API_BASE,
      'Referer': `${CHAT_API_BASE}/`,
    };
  }

  /**
   * Make a batchexecute API request
   */
  async batchExecute(rpcId, requestData) {
    const url = `${CHAT_API_BASE}/_/DynamiteWebUi/data/batchexecute`;
    
    const rpcRequest = JSON.stringify([[
      [rpcId, JSON.stringify(requestData), null, "generic"]
    ]]);

    const body = new URLSearchParams({
      'f.req': rpcRequest,
    });

    console.log(`Making ${rpcId} request...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: body.toString(),
    });

    console.log(`Response status: ${response.status}`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed (${response.status}): ${text.substring(0, 500)}`);
    }

    const text = await response.text();
    return this.parseBatchResponse(text);
  }

  /**
   * Parse batchexecute response format
   */
  parseBatchResponse(text) {
    // Remove XSSI protection prefix
    const cleaned = text.replace(/^\)\]\}'/, '').trim();
    
    const lines = cleaned.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed) && parsed[0] && Array.isArray(parsed[0])) {
          for (const item of parsed[0]) {
            if (Array.isArray(item) && item.length >= 3 && typeof item[2] === 'string') {
              try {
                return JSON.parse(item[2]);
              } catch (e) {
                continue;
              }
            }
          }
        }
      } catch (e) {
        continue;
      }
    }

    return null;
  }

  /**
   * List all spaces/conversations
   * RPC: ACcr7e (GetPaginatedWorld)
   */
  async listSpaces() {
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

    return this.batchExecute('ACcr7e', request);
  }

  /**
   * Get space/group info
   * RPC: Xp7Hxe (GetGroup)
   */
  async getSpaceInfo(spaceId) {
    const request = [
      null,
      [[spaceId], null]  // group_id with space_id
    ];

    return this.batchExecute('Xp7Hxe', request);
  }

  /**
   * List topics/messages in a space
   * RPC: MJJSQe (ListTopics)
   */
  async listTopics(spaceId, pageSize = 25) {
    const request = [
      null,              // RequestHeader
      pageSize,          // page_size_for_topics  
      10,                // page_size_for_replies
      null,
      null,
      5,                 // page_size_for_unread_replies
      5,                 // page_size_for_read_replies
      [[spaceId], null]  // group_id
    ];

    return this.batchExecute('MJJSQe', request);
  }

  /**
   * Get self user status
   * RPC: eEvLnf (GetSelfUserStatus)
   */
  async getSelfUserStatus() {
    const request = [null];
    return this.batchExecute('eEvLnf', request);
  }
}

/**
 * Extract messages from response data
 */
function extractMessages(data, depth = 0) {
  const messages = [];
  
  if (!data || depth > 20) return messages;
  
  if (Array.isArray(data)) {
    // Look for message-like structures
    // Messages have: [message_id, topic_id, creator, timestamp, ..., text_body, ...]
    if (data.length >= 15) {
      // Check for message structure
      const messageId = data[0];
      const creator = data[2];
      const timestamp = data[3];
      const textBody = data[10];
      
      if (typeof messageId === 'string' && 
          typeof textBody === 'string' && 
          textBody.length > 0 && 
          textBody.length < 50000) {
        
        // Extract creator name
        let creatorName = 'Unknown';
        if (Array.isArray(creator)) {
          creatorName = creator[2] || creator[4] || creator[0] || 'Unknown';
        }
        
        messages.push({
          id: messageId,
          text: textBody,
          timestamp: timestamp,
          creator: creatorName,
          raw: data
        });
      }
    }
    
    // Recurse into arrays
    for (const item of data) {
      messages.push(...extractMessages(item, depth + 1));
    }
  }
  
  return messages;
}

/**
 * Extract spaces from response data
 */
function extractSpaces(data) {
  const spaces = [];
  
  function traverse(obj, depth = 0) {
    if (!obj || depth > 15) return;
    
    if (Array.isArray(obj)) {
      // Look for space structures
      // Spaces typically have [group_id, name, type, ...]
      if (obj.length >= 5) {
        const groupId = obj[0];
        
        // Check if first element is a group_id structure
        if (Array.isArray(groupId) && groupId.length >= 1) {
          const spaceId = groupId[0];
          const name = obj[2] || obj[1];
          
          if (typeof spaceId === 'string' && spaceId.length > 5) {
            spaces.push({
              id: spaceId,
              name: typeof name === 'string' ? name : 'Unknown',
              raw: obj
            });
          }
        }
      }
      
      for (const item of obj) {
        traverse(item, depth + 1);
      }
    }
  }
  
  traverse(data);
  
  // Deduplicate by ID
  const seen = new Set();
  return spaces.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

/**
 * Pretty print data structure
 */
function prettyPrint(data, maxDepth = 4) {
  console.log(JSON.stringify(data, null, 2).substring(0, 3000));
}

async function main() {
  console.log('=== Google Chat Client (Dynamite Token Auth) ===\n');
  
  // Ensure we have valid tokens
  let tokens;
  try {
    tokens = await ensureValidTokens();
  } catch (e) {
    console.error('Failed to get tokens:', e.message);
    process.exit(1);
  }

  console.log('Dynamite Token:', tokens.dynamite_token?.substring(0, 40) + '...\n');

  const client = new GoogleChatClient(tokens);

  // Get self user status
  console.log('--- Getting Self User Status ---\n');
  try {
    const status = await client.getSelfUserStatus();
    if (status) {
      console.log('User status:');
      prettyPrint(status);
    }
  } catch (e) {
    console.error('Error getting user status:', e.message);
  }

  // List spaces
  console.log('\n--- Listing Spaces ---\n');
  try {
    const spacesData = await client.listSpaces();
    
    if (spacesData) {
      const spaces = extractSpaces(spacesData);
      console.log(`Found ${spaces.length} space(s):\n`);
      
      for (const space of spaces.slice(0, 10)) {
        console.log(`  - ${space.name} (${space.id})`);
      }
      
      if (spaces.length > 10) {
        console.log(`  ... and ${spaces.length - 10} more`);
      }
    } else {
      console.log('No spaces data returned');
    }
  } catch (e) {
    console.error('Error listing spaces:', e.message);
  }

  // Get space info
  console.log(`\n--- Getting Space Info (${TARGET_SPACE_ID}) ---\n`);
  try {
    const spaceInfo = await client.getSpaceInfo(TARGET_SPACE_ID);
    if (spaceInfo) {
      console.log('Space info:');
      prettyPrint(spaceInfo);
    }
  } catch (e) {
    console.error('Error getting space info:', e.message);
  }

  // List messages in space
  console.log(`\n--- Fetching Messages (${TARGET_SPACE_ID}) ---\n`);
  try {
    const topicsData = await client.listTopics(TARGET_SPACE_ID, 20);
    
    if (topicsData) {
      const messages = extractMessages(topicsData);
      
      if (messages.length > 0) {
        console.log(`Found ${messages.length} message(s):\n`);
        
        // Show most recent messages
        for (const msg of messages.slice(0, 10)) {
          const date = msg.timestamp ? new Date(parseInt(msg.timestamp) / 1000) : null;
          console.log(`[${date?.toLocaleString() || 'Unknown'}] ${msg.creator}:`);
          console.log(`  ${msg.text.substring(0, 200)}`);
          console.log();
        }
      } else {
        console.log('No messages found in response');
        console.log('\nRaw response:');
        prettyPrint(topicsData);
      }
    }
  } catch (e) {
    console.error('Error fetching messages:', e.message);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
