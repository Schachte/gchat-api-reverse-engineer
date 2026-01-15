/**
 * Google Chat API Client
 * 
 * Fetches recent messages from Google Chat spaces/rooms using the
 * reverse-engineered Dynamite API from purple-googlechat.
 */

import { ensureValidTokens } from './auth.js';
import * as protobuf from 'protobufjs';
import * as fs from 'fs';
import * as path from 'path';

const CHAT_API_BASE = 'https://chat.google.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

class GoogleChatClient {
  constructor(tokens) {
    this.tokens = tokens;
    this.root = null;
  }

  /**
   * Load protobuf definitions
   */
  async loadProto() {
    // For simplicity, we'll use JSON requests instead of protobuf
    // The API accepts both JSON and protobuf
    console.log('Proto loading skipped - using JSON API');
  }

  /**
   * Make an authenticated API request
   */
  async apiRequest(endpoint, method = 'POST', body = null) {
    const url = `${CHAT_API_BASE}${endpoint}`;
    
    const headers = {
      'Authorization': `Bearer ${this.tokens.dynamite_token}`,
      'Content-Type': 'application/json+protobuf',
      'User-Agent': USER_AGENT,
      'X-Goog-Encode-Response-If-Executable': 'base64',
    };

    const options = {
      method,
      headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed (${response.status}): ${error}`);
    }

    const text = await response.text();
    
    // The response often has a )]}' prefix for XSSI protection
    const jsonStr = text.startsWith(")]}'") ? text.slice(5) : text;
    
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // Return raw text if not JSON
      return text;
    }
  }

  /**
   * Get list of spaces/groups the user is in
   */
  async listSpaces() {
    // Using the paginated world API
    const body = {
      "1": {  // RequestHeader
        "2": 3,  // client_type: WEB
        "4": "en"  // locale
      },
      "2": 50  // page_size
    };

    try {
      const response = await this.apiRequest('/api/get_group_summaries', 'POST', body);
      return response;
    } catch (e) {
      console.error('Error listing spaces:', e.message);
      return null;
    }
  }

  /**
   * List topics/messages in a space
   * @param {string} spaceId - The space ID to fetch messages from
   * @param {number} pageSize - Number of topics to fetch
   */
  async listTopics(spaceId, pageSize = 20) {
    const body = {
      "1": {  // RequestHeader
        "2": 3,  // client_type: WEB
        "4": "en"
      },
      "8": {  // group_id.space_id
        "1": { "1": spaceId }
      },
      "2": pageSize,  // page_size_for_topics
      "3": 10,  // page_size_for_replies
      "6": 5,   // page_size_for_unread_replies
      "7": 5    // page_size_for_read_replies
    };

    const response = await this.apiRequest('/api/list_topics', 'POST', body);
    return response;
  }

  /**
   * Get self user info
   */
  async getSelfUser() {
    const body = {
      "1": {  // RequestHeader
        "2": 3,
        "4": "en"
      }
    };

    const response = await this.apiRequest('/api/get_self_user_status', 'POST', body);
    return response;
  }

  /**
   * Parse a message from API response format
   */
  parseMessage(msg) {
    if (!msg) return null;
    
    return {
      id: msg["1"]?.["2"],  // message_id
      text: msg["10"],      // text_body
      timestamp: msg["3"],  // create_time
      creator: {
        id: msg["2"]?.["1"]?.["1"],  // creator.user_id.id
        name: msg["2"]?.["2"],       // creator.name
        email: msg["2"]?.["4"]       // creator.email
      },
      lastEditTime: msg["17"]
    };
  }

  /**
   * Parse a topic from API response
   */
  parseTopic(topic) {
    if (!topic) return null;
    
    const topicId = topic["1"];
    const replies = topic["7"] || [];
    
    return {
      id: topicId?.["2"],
      spaceId: topicId?.["3"]?.["1"]?.["1"],
      createTime: topic["15"],
      sortTime: topic["2"],
      messages: replies.map(r => this.parseMessage(r)).filter(Boolean)
    };
  }
}

/**
 * Pretty print a message
 */
function printMessage(msg) {
  if (!msg) return;
  
  const date = msg.timestamp ? new Date(parseInt(msg.timestamp) / 1000) : null;
  const dateStr = date ? date.toLocaleString() : 'Unknown time';
  const sender = msg.creator?.name || msg.creator?.email || 'Unknown';
  
  console.log(`  [${dateStr}] ${sender}:`);
  console.log(`    ${msg.text || '(no text)'}`);
  console.log();
}

/**
 * Main function
 */
async function main() {
  console.log('=== Google Chat Message Fetcher ===\n');

  // Get valid tokens
  const tokens = await ensureValidTokens();
  console.log('Authenticated successfully!\n');

  const client = new GoogleChatClient(tokens);

  // Get self user info
  console.log('Getting user info...');
  const selfUser = await client.getSelfUser();
  if (selfUser) {
    console.log('Logged in as user');
  }

  // List spaces
  console.log('\nFetching spaces...');
  const spaces = await client.listSpaces();
  
  if (!spaces) {
    console.log('Could not fetch spaces. The API format may have changed.');
    console.log('\nTrying alternative approach...\n');
  }

  // If we have space data, let's try to parse it
  // The response format uses numeric keys matching protobuf field numbers
  const groupSummaries = spaces?.["1"] || [];
  
  if (groupSummaries.length === 0) {
    console.log('No spaces found or unable to parse response.');
    console.log('\nRaw API response preview:');
    console.log(JSON.stringify(spaces, null, 2).slice(0, 2000));
    return;
  }

  console.log(`\nFound ${groupSummaries.length} space(s):\n`);
  
  for (let i = 0; i < Math.min(groupSummaries.length, 5); i++) {
    const group = groupSummaries[i];
    const groupData = group?.["1"];  // Group object
    const groupId = groupData?.["1"];  // GroupId
    const spaceId = groupId?.["1"]?.["1"];  // space_id
    const dmId = groupId?.["3"]?.["1"];     // dm_id
    const name = groupData?.["2"] || '(DM)';
    
    const id = spaceId || dmId;
    console.log(`${i + 1}. ${name} (ID: ${id})`);
  }

  // Fetch messages from the first space/DM
  if (groupSummaries.length > 0) {
    const firstGroup = groupSummaries[0]?.["1"];
    const groupId = firstGroup?.["1"];
    const spaceId = groupId?.["1"]?.["1"] || groupId?.["3"]?.["1"];
    const groupName = firstGroup?.["2"] || 'DM';

    if (spaceId) {
      console.log(`\n--- Recent messages from "${groupName}" ---\n`);
      
      try {
        const topics = await client.listTopics(spaceId);
        const topicList = topics?.["1"] || [];
        
        console.log(`Found ${topicList.length} topic(s)/thread(s):\n`);
        
        for (const topic of topicList.slice(0, 5)) {
          const parsed = client.parseTopic(topic);
          if (parsed && parsed.messages.length > 0) {
            console.log(`Thread ${parsed.id || '(unknown)'}:`);
            for (const msg of parsed.messages.slice(-3)) {
              printMessage(msg);
            }
          }
        }
      } catch (e) {
        console.error('Error fetching topics:', e.message);
      }
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
