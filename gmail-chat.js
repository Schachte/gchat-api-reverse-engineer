/**
 * Google Chat via Gmail API
 * 
 * Uses the Gmail embedded Chat API which works with browser cookies
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

const COOKIES_FILE = '/Users/schachte/Downloads/cookies.txt';
const TARGET_SPACE_ID = 'AAAAHKvY2CQ';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Parse Netscape format cookies file
 */
function parseNetscapeCookies(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const cookies = {};
  
  for (const line of content.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    
    const parts = line.split('\t');
    if (parts.length >= 7) {
      const [domain, , path, secure, expires, name, value] = parts;
      
      if (domain.includes('google.com')) {
        const key = name.trim();
        // Prefer more specific domains
        if (!cookies[key] || domain === 'mail.google.com' || domain === '.google.com') {
          cookies[key] = value.trim();
        }
      }
    }
  }
  
  return cookies;
}

/**
 * Build cookie string
 */
function buildCookieString(cookies) {
  const important = [
    'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
    '__Secure-1PSID', '__Secure-3PSID',
    '__Secure-1PAPISID', '__Secure-3PAPISID',
    'OSID', '__Secure-OSID', 'GMAIL_AT', 'COMPASS'
  ];
  
  const parts = [];
  for (const key of important) {
    if (cookies[key]) {
      parts.push(`${key}=${cookies[key]}`);
    }
  }
  
  return parts.join('; ');
}

/**
 * Generate SAPISIDHASH
 */
function generateSapisidHash(sapisid, origin = 'https://mail.google.com') {
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${sapisid} ${origin}`;
  const hash = crypto.createHash('sha1').update(input).digest('hex');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

/**
 * Gmail Chat API client
 */
class GmailChatClient {
  constructor(cookies) {
    this.cookies = cookies;
    this.cookieString = buildCookieString(cookies);
    this.sapisid = cookies['SAPISID'] || cookies['__Secure-1PAPISID'];
    this.gmailAt = cookies['GMAIL_AT'];
  }

  getHeaders(origin = 'https://mail.google.com') {
    const headers = {
      'Cookie': this.cookieString,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Origin': origin,
      'Referer': `${origin}/`,
      'X-Goog-Authuser': '0',
    };

    if (this.sapisid) {
      headers['Authorization'] = generateSapisidHash(this.sapisid, origin);
    }

    return headers;
  }

  /**
   * Make a batchexecute request to Gmail's chat API
   */
  async batchExecute(rpcid, data, endpoint = 'https://mail.google.com/_/DynamiteWebUi/data/batchexecute') {
    const rpcRequest = JSON.stringify([[
      [rpcid, JSON.stringify(data), null, "generic"]
    ]]);

    const body = new URLSearchParams({
      'f.req': rpcRequest,
    });

    // Add at parameter if we have GMAIL_AT
    if (this.gmailAt) {
      body.append('at', this.gmailAt);
    }

    console.log(`Making request to ${rpcid}...`);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.getHeaders(),
      body: body.toString(),
    });

    console.log(`Response status: ${response.status}`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Request failed: ${response.status} - ${text.substring(0, 500)}`);
    }

    const text = await response.text();
    return this.parseResponse(text);
  }

  /**
   * Parse batchexecute response
   */
  parseResponse(text) {
    // Remove XSSI prefix
    const cleaned = text.replace(/^\)\]\}'/, '').trim();
    
    const results = [];
    for (const line of cleaned.split('\n')) {
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) {
          results.push(parsed);
        }
      } catch (e) {
        // Skip non-JSON lines
      }
    }

    // Extract response data
    for (const result of results) {
      if (Array.isArray(result) && result[0]) {
        for (const item of result[0]) {
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
   * Get space info
   */
  async getSpaceInfo(spaceId) {
    // Xp7Hxe = GetGroup RPC
    const data = [
      null,
      [[spaceId], null]
    ];
    return this.batchExecute('Xp7Hxe', data);
  }

  /**
   * List topics/messages in a space
   */
  async listTopics(spaceId, pageSize = 25) {
    // MJJSQe = ListTopics RPC
    const data = [
      null,              // RequestHeader
      pageSize,          // page_size_for_topics  
      10,                // page_size_for_replies
      null,
      null,
      5,                 // page_size_for_unread_replies
      5,                 // page_size_for_read_replies
      [[spaceId], null]  // group_id with space_id
    ];
    return this.batchExecute('MJJSQe', data);
  }

  /**
   * List spaces/conversations
   */
  async listSpaces() {
    // ACcr7e = GetPaginatedWorld
    const data = [
      null,  // RequestHeader
      50,    // page_size
      null,  // page_token
      1,     // include_spaces
      null,
      null,
      null,
      1      // include_dms
    ];
    return this.batchExecute('ACcr7e', data);
  }
}

/**
 * Pretty print data structure
 */
function prettyPrint(data, indent = 0, maxDepth = 6) {
  if (indent > maxDepth) {
    console.log('  '.repeat(indent) + '...');
    return;
  }

  const prefix = '  '.repeat(indent);
  
  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log(prefix + '[]');
    } else if (data.every(x => x === null || typeof x !== 'object')) {
      console.log(prefix + JSON.stringify(data).substring(0, 100));
    } else {
      console.log(prefix + '[');
      data.slice(0, 5).forEach((item, i) => {
        process.stdout.write(prefix + `  [${i}]: `);
        if (typeof item === 'string' && item.length > 80) {
          console.log(`"${item.substring(0, 80)}..."`);
        } else if (typeof item === 'object' && item !== null) {
          console.log('');
          prettyPrint(item, indent + 2, maxDepth);
        } else {
          console.log(JSON.stringify(item));
        }
      });
      if (data.length > 5) {
        console.log(prefix + `  ... (${data.length - 5} more items)`);
      }
      console.log(prefix + ']');
    }
  } else if (data && typeof data === 'object') {
    console.log(prefix + JSON.stringify(data).substring(0, 200));
  } else {
    console.log(prefix + JSON.stringify(data));
  }
}

/**
 * Extract text messages from response
 */
function extractMessages(data, messages = []) {
  if (!data) return messages;
  
  if (Array.isArray(data)) {
    // Look for message structures - usually have timestamp and text
    // Messages typically look like: [id, creator, timestamp, ..., text_body, ...]
    if (data.length >= 10) {
      // Check if index 10 has text (text_body field)
      const textBody = data[10];
      const createTime = data[3];
      const creator = data[2];
      
      if (typeof textBody === 'string' && textBody.length > 0 && textBody.length < 10000) {
        const creatorName = creator?.[2] || creator?.[4] || 'Unknown';
        messages.push({
          text: textBody,
          timestamp: createTime,
          creator: creatorName
        });
      }
    }
    
    // Recurse into arrays
    for (const item of data) {
      extractMessages(item, messages);
    }
  }
  
  return messages;
}

async function main() {
  console.log('=== Gmail Chat API Client ===\n');
  
  // Parse cookies
  const cookies = parseNetscapeCookies(COOKIES_FILE);
  
  console.log('Key cookies:');
  console.log(`  SAPISID: ${cookies['SAPISID'] ? 'Present' : 'Missing'}`);
  console.log(`  GMAIL_AT: ${cookies['GMAIL_AT'] ? 'Present' : 'Missing'}`);
  console.log(`  SID: ${cookies['SID'] ? 'Present' : 'Missing'}`);
  console.log();

  const client = new GmailChatClient(cookies);
  
  console.log(`Target Space: ${TARGET_SPACE_ID}\n`);

  // Try to get space info
  console.log('--- Getting Space Info ---\n');
  try {
    const spaceInfo = await client.getSpaceInfo(TARGET_SPACE_ID);
    console.log('Space info:');
    prettyPrint(spaceInfo);
  } catch (e) {
    console.error('Error getting space info:', e.message);
  }

  // List topics/messages
  console.log('\n--- Fetching Messages ---\n');
  try {
    const topics = await client.listTopics(TARGET_SPACE_ID, 20);
    
    console.log('Topics response:');
    prettyPrint(topics);
    
    // Try to extract messages
    const messages = extractMessages(topics);
    if (messages.length > 0) {
      console.log(`\n=== Found ${messages.length} message(s) ===\n`);
      for (const msg of messages.slice(0, 10)) {
        const date = msg.timestamp ? new Date(parseInt(msg.timestamp) / 1000) : null;
        console.log(`[${date?.toLocaleString() || 'Unknown'}] ${msg.creator}:`);
        console.log(`  ${msg.text.substring(0, 200)}`);
        console.log();
      }
    }
  } catch (e) {
    console.error('Error fetching messages:', e.message);
  }

  // Also list spaces to see what's available
  console.log('\n--- Listing Spaces ---\n');
  try {
    const spaces = await client.listSpaces();
    console.log('Spaces response preview:');
    prettyPrint(spaces);
  } catch (e) {
    console.error('Error listing spaces:', e.message);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
