/**
 * Google Chat Client - Using browser_cookie3 for cookie extraction
 * 
 * This is the final working implementation based on mautrix-googlechat
 */

import { execSync } from 'child_process';
import * as fs from 'fs';

const GC_BASE_URL = 'https://chat.google.com/u/0';
const API_KEY = 'AIzaSyD7InnYR3VKdb4j2rMUEbTCIr2VyEazl6k';
const TARGET_SPACE_ID = process.env.SPACE_ID || 'AAAAHKvY2CQ';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

/**
 * Extract cookies using Python browser_cookie3 library
 */
function extractCookies() {
  console.log('Extracting cookies from Chrome (via Python)...');
  
  try {
    const result = execSync('python3 extract_cookies.py', {
      cwd: '/Users/schachte/googlechat-client',
      encoding: 'utf-8',
      timeout: 30000
    });
    
    return JSON.parse(result);
  } catch (e) {
    console.error('Failed to extract cookies:', e.message);
    return null;
  }
}

/**
 * Build cookie header string
 */
function buildCookieString(cookies) {
  return Object.entries(cookies)
    .filter(([_, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Google Chat Client
 */
class GoogleChatClient {
  constructor(cookies) {
    this.cookies = cookies;
    this.cookieString = buildCookieString(cookies);
    this.xsrfToken = null;
    this.apiReqId = 0;
  }

  getHeaders(extra = {}) {
    return {
      'Cookie': this.cookieString,
      'User-Agent': USER_AGENT,
      'Connection': 'Keep-Alive',
      ...extra
    };
  }

  /**
   * Fetch XSRF token from /mole/world
   */
  async refreshTokens() {
    const params = new URLSearchParams({
      origin: 'https://mail.google.com',
      shell: '9',
      hl: 'en',
      wfi: 'gtn-roster-iframe-id',
      hs: JSON.stringify(["h_hs",null,null,[1,0],null,null,"gmail.pinto-server_20230730.06_p0",1,null,[15,38,36,35,26,30,41,18,24,11,21,14,6],null,null,"3Mu86PSulM4.en..es5",0,null,null,[0]])
    });

    const url = `${GC_BASE_URL}/mole/world?${params}`;
    
    console.log('Fetching XSRF token...');

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders({
        'authority': 'chat.google.com',
        'referer': 'https://mail.google.com/',
      }),
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      throw new Error(`Redirected to login: ${location?.substring(0, 100)}`);
    }

    const body = await response.text();
    const wizMatch = body.match(/>window\.WIZ_global_data = ({.+?});<\/script>/s);
    
    if (!wizMatch) {
      fs.writeFileSync('/tmp/mole_response.html', body);
      throw new Error('No WIZ_global_data found (saved to /tmp/mole_response.html)');
    }

    const wizData = JSON.parse(wizMatch[1]);
    
    if (wizData['qwAQke'] === 'AccountsSignInUi') {
      throw new Error('Not logged in - cookies invalid');
    }

    this.xsrfToken = wizData['SMqcke'];
    console.log(`Got XSRF token: ${this.xsrfToken?.substring(0, 30)}...`);
    return this.xsrfToken;
  }

  /**
   * Make API request (pblite/JSON format)
   */
  async apiRequest(endpoint, requestData) {
    if (!this.xsrfToken) {
      await this.refreshTokens();
    }

    this.apiReqId++;
    
    // Try with minimal params like mautrix does
    const params = new URLSearchParams({
      alt: 'protojson',
      key: API_KEY,
    });

    const url = `${GC_BASE_URL}/api/${endpoint}?${params}`;
    
    console.log(`API: ${endpoint}`);
    console.log(`Request: ${JSON.stringify(requestData).substring(0, 200)}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders({
        'Content-Type': 'application/json+protobuf',
        'x-framework-xsrf-token': this.xsrfToken,
      }),
      body: JSON.stringify(requestData),
    });

    console.log(`Response: ${response.status}`);
    
    const text = await response.text();
    
    if (!response.ok) {
      throw new Error(`API ${response.status}: ${text.substring(0, 300)}`);
    }

    const cleaned = text.replace(/^\)\]\}'/, '').trim();
    
    try {
      return JSON.parse(cleaned);
    } catch {
      return text;
    }
  }

  // Request header structure (pblite format - 1-indexed)
  // RequestHeader proto has: client_type=1, client_version=2, client_feature_capabilities=3
  // client_type: WEB=2
  // client_version: 2440378181258
  // client_feature_capabilities: spam_room_invites_level=1 (FULLY_SUPPORTED=1)
  get requestHeader() {
    return [
      null,  // index 0 (pblite often has type name here, we use null)
      2,     // client_type = WEB (field 1)
      "2440378181258",  // client_version (field 2) - as string
      [null, 1]  // client_feature_capabilities (field 3) with spam_room_invites_level=1
    ];
  }

  async getSelfUserStatus() {
    // GetSelfUserStatusRequest has: request_header (field 1)
    return this.apiRequest('get_self_user_status', [
      null,  // index 0
      this.requestHeader  // field 1: request_header
    ]);
  }

  async getPaginatedWorld(pageSize = 50) {
    // PaginatedWorldRequest fields:
    // 1: request_header, 2: fetch_from_user_spaces, 7: fetch_from_user_dms
    return this.apiRequest('paginated_world', [
      null,  // index 0
      this.requestHeader,  // field 1
      pageSize,  // field 2: fetch_from_user_spaces
      null, null, null, null,  // fields 3-6
      pageSize,  // field 7: fetch_from_user_dms
    ]);
  }

  async getGroup(spaceId) {
    // GetGroupRequest: request_header (1), group_id (2)
    // GroupId: space_id (1), dm_id (2)
    return this.apiRequest('get_group', [
      null,  // index 0
      this.requestHeader,  // field 1
      [null, [spaceId]]  // field 2: group_id with space_id
    ]);
  }

  async listTopics(spaceId, pageSize = 25) {
    // ListTopicsRequest: request_header (1), group_id (2), page_size (3)
    return this.apiRequest('list_topics', [
      null,  // index 0
      this.requestHeader,  // field 1
      [null, [spaceId]],  // field 2: group_id
      pageSize,  // field 3: page_size
    ]);
  }
  
  async listMessages(spaceId, topicId, pageSize = 20) {
    // ListMessagesRequest: request_header (1), topic_id (2), page_size (3)
    // TopicId: group_id (1), topic_id (2)
    return this.apiRequest('list_messages', [
      null,  // index 0
      this.requestHeader,  // field 1
      [null, [null, [spaceId]], topicId],  // field 2: topic_id with embedded group_id
      pageSize,  // field 3
    ]);
  }
}

/**
 * Extract space info from response
 */
function extractSpaces(data, spaces = []) {
  if (!data) return spaces;
  
  if (Array.isArray(data)) {
    // Look for space-like structures
    if (data.length >= 2 && Array.isArray(data[0]) && typeof data[0][0] === 'string') {
      const spaceId = data[0][0];
      if (spaceId && spaceId.length > 5 && !spaceId.includes(' ')) {
        const name = findString(data, 2) || findString(data, 1) || 'Unknown';
        if (!spaces.find(s => s.id === spaceId)) {
          spaces.push({ id: spaceId, name });
        }
      }
    }
    
    for (const item of data) {
      extractSpaces(item, spaces);
    }
  }
  
  return spaces;
}

function findString(arr, maxDepth = 3) {
  if (maxDepth <= 0) return null;
  if (typeof arr === 'string' && arr.length > 0 && arr.length < 200) return arr;
  if (Array.isArray(arr)) {
    for (const item of arr) {
      const found = findString(item, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extract messages from topics response
 */
function extractMessages(data, messages = [], depth = 0) {
  if (!data || depth > 20) return messages;
  
  if (Array.isArray(data)) {
    // Message structure has text_body at various positions
    // Look for arrays with string content that looks like a message
    if (data.length >= 10) {
      // Check for message-like structure
      const textBody = data[10] || data[9] || data[8];
      const timestamp = data[3] || data[4];
      const creator = data[2];
      
      if (typeof textBody === 'string' && textBody.length > 0 && textBody.length < 50000) {
        let creatorName = 'Unknown';
        if (Array.isArray(creator)) {
          creatorName = creator[2] || creator[4] || creator[0] || 'Unknown';
        }
        
        // Check if timestamp looks valid (microseconds)
        if (timestamp && typeof timestamp === 'string' && /^\d{16}$/.test(timestamp)) {
          messages.push({
            text: textBody,
            timestamp,
            creator: creatorName
          });
        }
      }
    }
    
    for (const item of data) {
      extractMessages(item, messages, depth + 1);
    }
  }
  
  return messages;
}

async function main() {
  console.log('=== Google Chat Client (Final Version) ===\n');

  // Extract cookies
  const cookies = extractCookies();
  if (!cookies) {
    process.exit(1);
  }

  // Check required cookies
  const required = ['SID', 'HSID', 'SSID', 'OSID'];
  console.log('\nCookies:');
  for (const name of required) {
    console.log(`  ${name}: ${cookies[name] ? 'OK' : 'MISSING'}`);
  }
  
  if (!required.every(n => cookies[n])) {
    console.error('\nMissing required cookies!');
    process.exit(1);
  }

  const client = new GoogleChatClient(cookies);

  // Get XSRF token
  try {
    await client.refreshTokens();
  } catch (e) {
    console.error('\nAuth failed:', e.message);
    process.exit(1);
  }

  // Get self info
  console.log('\n--- Self User Status ---');
  try {
    const status = await client.getSelfUserStatus();
    console.log(JSON.stringify(status, null, 2).substring(0, 1500));
  } catch (e) {
    console.error('Error:', e.message);
  }

  // List conversations
  console.log('\n--- Conversations ---');
  try {
    const world = await client.getPaginatedWorld(30);
    const spaces = extractSpaces(world);
    
    console.log(`Found ${spaces.length} conversations:`);
    for (const space of spaces.slice(0, 15)) {
      const marker = space.id === TARGET_SPACE_ID ? ' ← TARGET' : '';
      console.log(`  ${space.name} (${space.id})${marker}`);
    }
  } catch (e) {
    console.error('Error:', e.message);
  }

  // Get target space
  console.log(`\n--- Space: ${TARGET_SPACE_ID} ---`);
  try {
    const group = await client.getGroup(TARGET_SPACE_ID);
    console.log(JSON.stringify(group, null, 2).substring(0, 1000));
  } catch (e) {
    console.error('Error:', e.message);
  }

  // List topics/messages
  console.log(`\n--- Messages ---`);
  try {
    const topics = await client.listTopics(TARGET_SPACE_ID, 20);
    const messages = extractMessages(topics);
    
    if (messages.length > 0) {
      console.log(`Found ${messages.length} messages:\n`);
      for (const msg of messages.slice(0, 10)) {
        const date = new Date(parseInt(msg.timestamp) / 1000);
        console.log(`[${date.toLocaleString()}] ${msg.creator}:`);
        console.log(`  ${msg.text.substring(0, 150)}`);
        console.log();
      }
    } else {
      console.log('No messages extracted. Raw response:');
      console.log(JSON.stringify(topics, null, 2).substring(0, 2000));
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
