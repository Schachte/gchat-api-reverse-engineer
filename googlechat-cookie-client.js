/**
 * Google Chat Client - Cookie-based Auth (following mautrix-googlechat)
 * 
 * This implementation uses browser cookies to authenticate.
 * Required cookies: COMPASS, SSID, SID, OSID, HSID
 * 
 * Auth flow:
 * 1. Extract cookies from Chrome (or use manually provided cookies)
 * 2. Fetch XSRF token from /mole/world endpoint
 * 3. Use XSRF token + cookies for API requests to /api/* endpoints
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import os from 'os';

const CHROME_COOKIE_PATH = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/Default/Cookies'
);

const GC_BASE_URL = 'https://chat.google.com/u/0';
const API_KEY = 'AIzaSyD7InnYR3VKdb4j2rMUEbTCIr2VyEazl6k';
const TARGET_SPACE_ID = process.env.SPACE_ID || 'AAAAHKvY2CQ';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

// Required cookies per mautrix-googlechat (original set)
// Plus additional modern secure cookies that Google now requires
const REQUIRED_COOKIES = ['COMPASS', 'SSID', 'SID', 'OSID', 'HSID'];
const ADDITIONAL_COOKIES = [
  '__Secure-1PSID', '__Secure-3PSID',
  '__Secure-1PAPISID', '__Secure-3PAPISID', 
  '__Secure-1PSIDTS', '__Secure-3PSIDTS',
  '__Secure-1PSIDCC', '__Secure-3PSIDCC',
  '__Secure-OSID', 'SAPISID', 'APISID',
  'NID', 'SIDCC', 'SOCS', 'AEC'
];

/**
 * Get Chrome's encryption key from macOS Keychain
 */
function getChromeEncryptionKey() {
  try {
    const password = execSync(
      'security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"',
      { encoding: 'utf-8' }
    ).trim();
    
    const salt = Buffer.from('saltysalt');
    const iterations = 1003;
    const keyLength = 16;
    
    return crypto.pbkdf2Sync(password, salt, iterations, keyLength, 'sha1');
  } catch (e) {
    console.error('Failed to get Chrome encryption key:', e.message);
    return null;
  }
}

/**
 * Decrypt Chrome cookie value (v10/v11 format)
 */
function decryptCookieValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length === 0) return '';
  
  const buf = Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(encryptedValue);
  
  // Check for v10/v11 prefix
  if (buf.length < 4) return buf.toString('utf-8');
  
  const prefix = buf.slice(0, 3).toString('ascii');
  
  if (prefix === 'v10' || prefix === 'v11') {
    try {
      const data = buf.slice(3);
      const iv = Buffer.alloc(16, 0x20); // space character
      
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      decipher.setAutoPadding(false);
      
      let decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
      
      // Remove PKCS7 padding
      const padLen = decrypted[decrypted.length - 1];
      if (padLen > 0 && padLen <= 16) {
        decrypted = decrypted.slice(0, -padLen);
      }
      
      return decrypted.toString('utf-8').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    } catch (e) {
      return '';
    }
  }
  
  return buf.toString('utf-8').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/**
 * Extract required cookies from Chrome
 */
function extractCookiesFromChrome() {
  console.log('Extracting cookies from Chrome...');
  
  if (!fs.existsSync(CHROME_COOKIE_PATH)) {
    throw new Error('Chrome cookie database not found');
  }
  
  const tempPath = '/tmp/chrome_cookies_copy.db';
  fs.copyFileSync(CHROME_COOKIE_PATH, tempPath);
  
  const key = getChromeEncryptionKey();
  if (!key) throw new Error('Could not get Chrome encryption key');
  
  const db = new Database(tempPath, { readonly: true });
  
  const allCookies = [...REQUIRED_COOKIES, ...ADDITIONAL_COOKIES];
  const query = `
    SELECT name, encrypted_value, value, host_key
    FROM cookies 
    WHERE host_key LIKE '%google.com%'
      AND name IN (${allCookies.map(n => `'${n}'`).join(',')})
  `;
  
  const rows = db.prepare(query).all();
  db.close();
  fs.unlinkSync(tempPath);
  
  const cookies = {};
  
  for (const row of rows) {
    let value = row.value;
    
    // If there's an encrypted value, try to decrypt it
    if (row.encrypted_value && row.encrypted_value.length > 0) {
      const decrypted = decryptCookieValue(row.encrypted_value, key);
      if (decrypted) {
        value = decrypted;
      }
    }
    
    // Debug SID specifically
    if (row.name === 'SID' && value) {
      console.log(`  [DEBUG] SID from ${row.host_key}: ${value.substring(0, 20)}... (len: ${value.length})`);
    }
    
    if (value) {
      // Prefer .google.com domain for most cookies, chat.google.com for OSID
      const domainPriority = row.host_key === '.google.com' || 
                            (row.name === 'OSID' && row.host_key.includes('chat.google.com'));
      
      if (!cookies[row.name] || domainPriority) {
        cookies[row.name] = value;
      }
    }
  }
  
  return cookies;
}

/**
 * Sanitize cookie value - ensure only ASCII printable characters
 */
function sanitizeCookieValue(value) {
  if (!value) return '';
  return value.split('').filter(c => {
    const code = c.charCodeAt(0);
    return code >= 0x21 && code <= 0x7E; // Printable ASCII excluding space
  }).join('');
}

/**
 * Build cookie header string
 */
function buildCookieString(cookies) {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${sanitizeCookieValue(value)}`)
    .filter(pair => pair.split('=')[1]) // Only include non-empty values
    .join('; ');
}

/**
 * Google Chat Client using cookie auth
 */
class GoogleChatClient {
  constructor(cookies) {
    this.cookies = cookies;
    this.cookieString = buildCookieString(cookies);
    this.xsrfToken = null;
    this.apiReqId = 0;
  }

  /**
   * Get headers for requests
   */
  getHeaders(extraHeaders = {}) {
    return {
      'Cookie': this.cookieString,
      'User-Agent': USER_AGENT,
      'Connection': 'Keep-Alive',
      ...extraHeaders
    };
  }

  /**
   * Fetch XSRF token from /mole/world
   * Based on mautrix-googlechat refresh_tokens()
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
    
    console.log('Fetching XSRF token from /mole/world...');

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders({
        'authority': 'chat.google.com',
        'referer': 'https://mail.google.com/',
      }),
      redirect: 'manual',
    });

    console.log(`Response status: ${response.status}`);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      console.log(`Redirected to: ${location}`);
      throw new Error('Not authenticated - redirected to login');
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch XSRF token: ${response.status}`);
    }

    const body = await response.text();
    
    // Parse WIZ_global_data
    const wizMatch = body.match(/>window\.WIZ_global_data = ({.+?});<\/script>/s);
    
    if (!wizMatch) {
      fs.writeFileSync('/tmp/mole_world_response.html', body);
      throw new Error('Could not find WIZ_global_data in response (saved to /tmp/mole_world_response.html)');
    }

    try {
      const wizData = JSON.parse(wizMatch[1]);
      
      if (wizData['qwAQke'] === 'AccountsSignInUi') {
        throw new Error('Not logged in - cookies are invalid');
      }

      this.xsrfToken = wizData['SMqcke'];
      
      if (!this.xsrfToken) {
        throw new Error('No XSRF token found in WIZ_global_data');
      }

      console.log(`Got XSRF token: ${this.xsrfToken.substring(0, 30)}...`);
      return this.xsrfToken;
    } catch (e) {
      if (e.message.includes('Not logged in') || e.message.includes('No XSRF')) {
        throw e;
      }
      throw new Error(`Failed to parse WIZ_global_data: ${e.message}`);
    }
  }

  /**
   * Make a protobuf API request
   * Based on mautrix-googlechat _gc_request()
   */
  async apiRequest(endpoint, requestBody) {
    if (!this.xsrfToken) {
      await this.refreshTokens();
    }

    this.apiReqId++;
    
    const params = new URLSearchParams({
      c: this.apiReqId.toString(),
      rt: 'b',  // response type: binary (base64 protobuf)
      alt: 'proto',
      key: API_KEY,
    });

    const url = `${GC_BASE_URL}/api/${endpoint}?${params}`;
    
    console.log(`Making API request to ${endpoint}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders({
        'Content-Type': 'application/x-protobuf',
        'X-Goog-Encode-Response-If-Executable': 'base64',
        'x-framework-xsrf-token': this.xsrfToken,
      }),
      body: requestBody,
    });

    console.log(`Response status: ${response.status}`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed: ${response.status} - ${text.substring(0, 500)}`);
    }

    const body = await response.arrayBuffer();
    return Buffer.from(body);
  }

  /**
   * Make a JSON/pblite API request (simpler format)
   */
  async apiRequestJson(endpoint, requestData) {
    if (!this.xsrfToken) {
      await this.refreshTokens();
    }

    this.apiReqId++;
    
    const params = new URLSearchParams({
      c: this.apiReqId.toString(),
      rt: 'j',  // response type: json
      alt: 'protojson',
      key: API_KEY,
    });

    const url = `${GC_BASE_URL}/api/${endpoint}?${params}`;
    
    console.log(`Making API request to ${endpoint}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders({
        'Content-Type': 'application/json+protobuf',
        'x-framework-xsrf-token': this.xsrfToken,
      }),
      body: JSON.stringify(requestData),
    });

    console.log(`Response status: ${response.status}`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed: ${response.status} - ${text.substring(0, 500)}`);
    }

    const text = await response.text();
    
    // Remove XSSI prefix if present
    const cleaned = text.replace(/^\)\]\}'/, '').trim();
    
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      return text;
    }
  }

  /**
   * Get self user status
   */
  async getSelfUserStatus() {
    // Request header structure based on mautrix
    const request = [
      [2, 2440378181258, [1]],  // request_header
    ];
    return this.apiRequestJson('get_self_user_status', request);
  }

  /**
   * Get paginated world (list of conversations)
   */
  async getPaginatedWorld(pageSize = 50) {
    const request = [
      [2, 2440378181258, [1]],  // request_header
      pageSize,  // fetch_from_user_spaces
      null,
      null,
      null,
      null,
      pageSize,  // fetch_from_user_dms
    ];
    return this.apiRequestJson('paginated_world', request);
  }

  /**
   * Get group info
   */
  async getGroup(spaceId) {
    const request = [
      [2, 2440378181258, [1]],  // request_header
      [[spaceId]],  // group_id
    ];
    return this.apiRequestJson('get_group', request);
  }

  /**
   * List topics in a group
   */
  async listTopics(spaceId, pageSize = 25) {
    const request = [
      [2, 2440378181258, [1]],  // request_header
      [[spaceId]],  // group_id
      pageSize,  // page_size
    ];
    return this.apiRequestJson('list_topics', request);
  }
}

/**
 * Pretty print response
 */
function prettyPrint(data) {
  console.log(JSON.stringify(data, null, 2).substring(0, 5000));
}

async function main() {
  console.log('=== Google Chat Client (Cookie Auth - mautrix style) ===\n');

  // Extract cookies from Chrome
  let cookies;
  try {
    cookies = extractCookiesFromChrome();
  } catch (e) {
    console.error('Failed to extract cookies:', e.message);
    process.exit(1);
  }

  // Check we have all required cookies
  console.log('Cookies found:');
  let missingCookies = false;
  
  // Check required
  for (const name of REQUIRED_COOKIES) {
    const value = cookies[name];
    const sanitized = sanitizeCookieValue(value);
    console.log(`  ${name}: ${sanitized ? `Found (${sanitized.length} chars)` : 'MISSING'}`);
    if (!sanitized) missingCookies = true;
  }
  
  // Check additional (not required, but helpful)
  console.log('\nAdditional cookies:');
  for (const name of ADDITIONAL_COOKIES) {
    const value = cookies[name];
    const sanitized = sanitizeCookieValue(value);
    if (sanitized) {
      console.log(`  ${name}: Found (${sanitized.length} chars)`);
    }
  }

  if (missingCookies) {
    console.error('\nMissing required cookies! Make sure you are logged into Google Chat in Chrome.');
    process.exit(1);
  }
  
  // Debug: show first few chars of SID cookie
  const sidValue = sanitizeCookieValue(cookies['SID']);
  console.log(`\nSID preview: ${sidValue?.substring(0, 30)}...`);

  console.log();

  const client = new GoogleChatClient(cookies);

  // Get XSRF token
  try {
    await client.refreshTokens();
  } catch (e) {
    console.error('Failed to get XSRF token:', e.message);
    process.exit(1);
  }

  // Get self user status
  console.log('\n--- Getting Self User Status ---\n');
  try {
    const status = await client.getSelfUserStatus();
    console.log('User status:');
    prettyPrint(status);
  } catch (e) {
    console.error('Error:', e.message);
  }

  // List conversations
  console.log('\n--- Getting Conversations ---\n');
  try {
    const world = await client.getPaginatedWorld(20);
    console.log('Conversations:');
    prettyPrint(world);
  } catch (e) {
    console.error('Error:', e.message);
  }

  // Get specific group
  console.log(`\n--- Getting Group ${TARGET_SPACE_ID} ---\n`);
  try {
    const group = await client.getGroup(TARGET_SPACE_ID);
    console.log('Group info:');
    prettyPrint(group);
  } catch (e) {
    console.error('Error:', e.message);
  }

  // List topics in group
  console.log(`\n--- Listing Topics in ${TARGET_SPACE_ID} ---\n`);
  try {
    const topics = await client.listTopics(TARGET_SPACE_ID, 20);
    console.log('Topics:');
    prettyPrint(topics);
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
