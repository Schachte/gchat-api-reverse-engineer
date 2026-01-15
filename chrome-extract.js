/**
 * Extract Google cookies directly from Chrome on macOS
 * and test Google Chat API endpoints
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import os from 'os';

const CHROME_COOKIE_PATH = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/Default/Cookies'
);

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TARGET_SPACE_ID = 'AAAAHKvY2CQ';

/**
 * Get Chrome's encryption key from macOS Keychain
 */
function getChromeEncryptionKey() {
  try {
    const result = execSync(
      'security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"',
      { encoding: 'utf-8' }
    ).trim();
    
    // Derive the actual key using PBKDF2
    const salt = 'saltysalt';
    const iterations = 1003;
    const keyLength = 16;
    
    const key = crypto.pbkdf2Sync(result, salt, iterations, keyLength, 'sha1');
    return key;
  } catch (e) {
    console.error('Failed to get Chrome encryption key:', e.message);
    console.error('You may need to allow terminal access in System Preferences > Security & Privacy > Privacy > Full Disk Access');
    return null;
  }
}

/**
 * Decrypt Chrome cookie value
 */
function decryptCookieValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length === 0) {
    return '';
  }

  // Convert to Buffer if needed
  const buf = Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(encryptedValue);
  
  // Check for 'v10' or 'v11' prefix (Chrome encryption versions)
  const prefix = buf.slice(0, 3).toString('ascii');
  
  if (prefix === 'v10' || prefix === 'v11') {
    try {
      // Remove version prefix
      const data = buf.slice(3);
      
      // AES-128-CBC with space-filled IV
      const iv = Buffer.alloc(16, 0x20); // 0x20 = space character
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      decipher.setAutoPadding(false);
      
      let decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
      
      // Remove PKCS7 padding manually
      const padLength = decrypted[decrypted.length - 1];
      if (padLength > 0 && padLength <= 16) {
        // Verify padding is valid
        let validPadding = true;
        for (let i = decrypted.length - padLength; i < decrypted.length; i++) {
          if (decrypted[i] !== padLength) {
            validPadding = false;
            break;
          }
        }
        if (validPadding) {
          decrypted = decrypted.slice(0, -padLength);
        }
      }
      
      // Convert to string, filtering out invalid characters
      const str = decrypted.toString('utf-8');
      // Remove any null bytes or control characters
      return str.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    } catch (e) {
      // console.error('Decryption failed:', e.message);
      return '';
    }
  }
  
  // Unencrypted value
  return buf.toString('utf-8').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/**
 * Extract Google cookies from Chrome
 */
function extractGoogleCookies() {
  console.log('Extracting cookies from Chrome...\n');
  
  // Copy the cookie database (Chrome locks it)
  const tempPath = '/tmp/chrome_cookies_copy.db';
  
  try {
    fs.copyFileSync(CHROME_COOKIE_PATH, tempPath);
  } catch (e) {
    console.error('Failed to copy cookie database:', e.message);
    console.error('Make sure Chrome is not running, or grant Full Disk Access');
    return null;
  }
  
  const key = getChromeEncryptionKey();
  if (!key) {
    return null;
  }
  
  const db = new Database(tempPath, { readonly: true });
  
  // Query for Google cookies
  const query = `
    SELECT host_key, name, encrypted_value, value, path, expires_utc, is_secure, is_httponly
    FROM cookies 
    WHERE host_key LIKE '%google.com%' 
       OR host_key LIKE '%youtube.com%'
    ORDER BY host_key, name
  `;
  
  const rows = db.prepare(query).all();
  db.close();
  
  // Clean up
  fs.unlinkSync(tempPath);
  
  const cookies = {};
  
  for (const row of rows) {
    let value = row.value;
    
    // Decrypt if needed
    if (row.encrypted_value && row.encrypted_value.length > 0) {
      value = decryptCookieValue(row.encrypted_value, key);
    }
    
    if (value) {
      const fullKey = `${row.host_key}:${row.name}`;
      cookies[fullKey] = {
        name: row.name,
        value: value,
        domain: row.host_key,
        path: row.path,
        secure: row.is_secure === 1,
        httpOnly: row.is_httponly === 1,
      };
    }
  }
  
  return cookies;
}

/**
 * Sanitize cookie value - remove any non-ASCII or control characters
 */
function sanitizeCookieValue(value) {
  if (!value) return '';
  // Only keep printable ASCII characters (0x20-0x7E)
  return value.split('').filter(c => {
    const code = c.charCodeAt(0);
    return code >= 0x20 && code <= 0x7E;
  }).join('');
}

/**
 * Build cookie string for a specific domain
 */
function buildCookieString(cookies, targetDomains) {
  const parts = [];
  const seen = new Set();
  
  for (const [key, cookie] of Object.entries(cookies)) {
    // Check if cookie matches any target domain
    const matches = targetDomains.some(domain => 
      cookie.domain.includes(domain) || domain.includes(cookie.domain.replace(/^\./, ''))
    );
    
    if (matches && !seen.has(cookie.name)) {
      const sanitizedValue = sanitizeCookieValue(cookie.value);
      if (sanitizedValue) {
        parts.push(`${cookie.name}=${sanitizedValue}`);
        seen.add(cookie.name);
      }
    }
  }
  
  return parts.join('; ');
}

/**
 * Generate SAPISIDHASH for authorization
 */
function generateSapisidHash(sapisid, origin) {
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${sapisid} ${origin}`;
  const hash = crypto.createHash('sha1').update(input).digest('hex');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

/**
 * Fetch XSRF token from Google Chat page
 */
async function getXsrfToken(cookies) {
  console.log('\n--- Fetching XSRF Token ---');
  
  const cookieString = buildCookieString(cookies, ['google.com', 'chat.google.com']);
  
  // Debug: show what cookies we're sending
  const cookieNames = cookieString.split('; ').map(c => c.split('=')[0]);
  console.log(`Sending ${cookieNames.length} cookies:`);
  console.log(cookieNames.join(', '));
  
  // Check if __Secure cookies are present
  const hasSecure = cookieNames.filter(n => n.startsWith('__Secure'));
  console.log(`Secure cookies: ${hasSecure.length > 0 ? hasSecure.join(', ') : 'NONE'}`);
  
  // Also check OSID specifically for chat.google.com
  const chatOSID = Object.values(cookies).find(c => c.name === 'OSID' && c.domain.includes('chat'));
  console.log(`Chat OSID: ${chatOSID ? 'Present' : 'Missing'}`);
  
  const response = await fetch('https://chat.google.com/', {
    method: 'GET',
    headers: {
      'Cookie': cookieString,
      'User-Agent': USER_AGENT,
    },
    redirect: 'manual',
  });
  
  console.log(`Chat page status: ${response.status}`);
  
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    console.log(`Redirect to: ${location}`);
    
    // If redirecting to accounts.google.com or login, we're not authenticated
    if (location && (location.includes('accounts.google.com') || location.includes('ServiceLogin'))) {
      console.log('Redirected to login - not authenticated');
      return null;
    }
    
    // Otherwise, follow the redirect
    console.log('Following redirect...');
    const redirectResponse = await fetch(location, {
      method: 'GET',
      headers: {
        'Cookie': cookieString,
        'User-Agent': USER_AGENT,
      },
      redirect: 'manual',
    });
    
    console.log(`Redirect response status: ${redirectResponse.status}`);
    
    if (redirectResponse.status >= 300 && redirectResponse.status < 400) {
      const location2 = redirectResponse.headers.get('location');
      console.log(`Second redirect to: ${location2}`);
      if (location2 && (location2.includes('accounts.google.com') || location2.includes('ServiceLogin'))) {
        return null;
      }
    }
    
    if (!redirectResponse.ok) {
      return null;
    }
    
    const html = await redirectResponse.text();
    
    // Look for tokens in redirected page
    const patterns = [
      /\"SNlM0e\":\"([^\"]+)\"/,
      /\"FdrFJe\":\"([^\"]+)\"/,
      /\"at\":\"([^\"]+)\"/,
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        console.log(`Found XSRF token after redirect: ${match[1].substring(0, 30)}...`);
        return match[1];
      }
    }
    
    return null;
  }
  
  const html = await response.text();
  
  // Look for various token patterns
  const patterns = [
    /\"SNlM0e\":\"([^\"]+)\"/,        // Standard XSRF
    /\"FdrFJe\":\"([^\"]+)\"/,        // Alt token
    /\"IJ1cOf\":\"([^\"]+)\"/,        // Another variant
    /name=\"at\"[^>]*value=\"([^\"]+)\"/,
    /\"at\":\"([^\"]+)\"/,
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      console.log(`Found XSRF token: ${match[1].substring(0, 30)}...`);
      return match[1];
    }
  }
  
  // Save page for debugging
  fs.writeFileSync('/tmp/chat_page.html', html);
  console.log('No token found. Page saved to /tmp/chat_page.html');
  
  // Try to find any potential tokens
  const tokenMatches = html.match(/\"[A-Za-z0-9_-]{20,}\"/g) || [];
  console.log(`Found ${tokenMatches.length} potential tokens`);
  
  return null;
}

/**
 * Test various Google Chat API endpoints
 */
async function testEndpoints(cookies, xsrfToken) {
  console.log('\n=== Testing API Endpoints ===\n');
  
  if (!xsrfToken) {
    console.log('No XSRF token - skipping endpoint tests');
    return;
  }
  
  // Get key cookie values
  const sapisid = Object.values(cookies).find(c => c.name === 'SAPISID')?.value;
  const sanitizedSapisid = sanitizeCookieValue(sapisid);
  
  console.log(`XSRF Token: ${xsrfToken.substring(0, 30)}...`);
  console.log(`SAPISID: ${sanitizedSapisid ? 'Yes' : 'No'}`);
  
  const cookieString = buildCookieString(cookies, ['google.com', 'chat.google.com']);
  const origin = 'https://chat.google.com';
  
  const headers = {
    'Cookie': cookieString,
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'Origin': origin,
    'Referer': `${origin}/`,
    'X-Goog-Authuser': '0',
  };
  
  if (sanitizedSapisid) {
    headers['Authorization'] = generateSapisidHash(sanitizedSapisid, origin);
  }
  
  // Test ListSpaces (GetPaginatedWorld)
  console.log('\n--- Testing: ListSpaces ---');
  
  const listSpacesRequest = [null, 50, null, 1, null, null, null, 1];
  const rpcRequest = JSON.stringify([[
    ['ACcr7e', JSON.stringify(listSpacesRequest), null, "generic"]
  ]]);
  
  const body = new URLSearchParams({ 
    'f.req': rpcRequest,
    'at': xsrfToken,
  }).toString();
  
  try {
    const response = await fetch('https://chat.google.com/_/DynamiteWebUi/data/batchexecute', {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
    });
    
    console.log(`Status: ${response.status}`);
    
    const text = await response.text();
    
    if (response.ok) {
      console.log('SUCCESS! Response:');
      console.log(text.substring(0, 1000));
      
      // Parse the response
      const cleaned = text.replace(/^\)\]\}'/, '').trim();
      for (const line of cleaned.split('\n')) {
        try {
          const parsed = JSON.parse(line);
          if (Array.isArray(parsed) && parsed[0]) {
            for (const item of parsed[0]) {
              if (Array.isArray(item) && item[2]) {
                const data = JSON.parse(item[2]);
                console.log('\nParsed data:');
                console.log(JSON.stringify(data, null, 2).substring(0, 2000));
              }
            }
          }
        } catch (e) {
          continue;
        }
      }
    } else {
      console.log(`Error: ${text.substring(0, 500)}`);
    }
  } catch (e) {
    console.log(`Request failed: ${e.message}`);
  }
}

/**
 * Test fetching actual chat messages
 */
async function fetchMessages(cookies, xsrfToken) {
  console.log('\n=== Fetching Messages from Space ===\n');
  console.log(`Space ID: ${TARGET_SPACE_ID}`);
  
  if (!xsrfToken) {
    console.log('No XSRF token - cannot fetch messages');
    return;
  }
  
  const sapisid = Object.values(cookies).find(c => c.name === 'SAPISID')?.value;
  const sanitizedSapisid = sanitizeCookieValue(sapisid);
  const cookieString = buildCookieString(cookies, ['google.com', 'chat.google.com']);
  
  const origin = 'https://chat.google.com';
  const url = 'https://chat.google.com/_/DynamiteWebUi/data/batchexecute';
  
  const headers = {
    'Cookie': cookieString,
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'Origin': origin,
    'Referer': `${origin}/`,
    'X-Goog-Authuser': '0',
  };
  
  if (sanitizedSapisid) {
    headers['Authorization'] = generateSapisidHash(sanitizedSapisid, origin);
  }
  
  // ListTopics RPC - MJJSQe
  const listTopicsRequest = [
    null,              // RequestHeader
    25,                // page_size_for_topics  
    10,                // page_size_for_replies
    null,
    null,
    5,                 // page_size_for_unread_replies
    5,                 // page_size_for_read_replies
    [[TARGET_SPACE_ID], null]  // group_id
  ];
  
  const rpcRequest = JSON.stringify([[
    ['MJJSQe', JSON.stringify(listTopicsRequest), null, "generic"]
  ]]);
  
  const body = new URLSearchParams({ 
    'f.req': rpcRequest,
    'at': xsrfToken,
  }).toString();
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
    });
    
    console.log(`Status: ${response.status}`);
    
    if (response.status >= 300 && response.status < 400) {
      console.log('Redirected to login - cookies not valid for chat.google.com');
      return;
    }
    
    const text = await response.text();
    
    if (response.ok) {
      console.log('Success! Parsing messages...\n');
      
      // Parse the batchexecute response
      const cleaned = text.replace(/^\)\]\}'/, '').trim();
      
      for (const line of cleaned.split('\n')) {
        try {
          const parsed = JSON.parse(line);
          if (Array.isArray(parsed) && parsed[0]) {
            // Look for the actual data
            for (const item of parsed[0]) {
              if (Array.isArray(item) && item[2]) {
                try {
                  const data = JSON.parse(item[2]);
                  console.log('Messages data:');
                  console.log(JSON.stringify(data, null, 2).substring(0, 3000));
                  return data;
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
    } else {
      console.log(`Error: ${text.substring(0, 500)}`);
    }
  } catch (e) {
    console.log(`Request failed: ${e.message}`);
  }
}

async function main() {
  console.log('=== Chrome Cookie Extractor & Google Chat Tester ===\n');
  
  // Check if Chrome cookie file exists
  if (!fs.existsSync(CHROME_COOKIE_PATH)) {
    console.error('Chrome cookie database not found at:', CHROME_COOKIE_PATH);
    console.error('Make sure Google Chrome is installed.');
    process.exit(1);
  }
  
  // Extract cookies
  const cookies = extractGoogleCookies();
  
  if (!cookies) {
    console.error('Failed to extract cookies');
    process.exit(1);
  }
  
  // Count Google cookies
  const googleCookies = Object.entries(cookies).filter(([k]) => k.includes('google.com'));
  console.log(`Extracted ${googleCookies.length} Google cookies`);
  
  // Show important cookies
  const important = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'OSID', '__Secure-1PAPISID', '__Secure-3PAPISID'];
  console.log('\nImportant cookies:');
  for (const name of important) {
    const cookie = Object.values(cookies).find(c => c.name === name);
    const val = cookie ? sanitizeCookieValue(cookie.value) : '';
    console.log(`  ${name}: ${val ? `Found (${val.length} chars)` : 'Missing'}`);
  }
  
  // Show domains we found cookies for
  const domains = new Set(Object.values(cookies).map(c => c.domain));
  console.log('\nCookie domains:', [...domains].sort().join(', '));
  
  // Get XSRF token first
  const xsrfToken = await getXsrfToken(cookies);
  
  // Test endpoints
  await testEndpoints(cookies, xsrfToken);
  
  // Try to fetch messages
  await fetchMessages(cookies, xsrfToken);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
