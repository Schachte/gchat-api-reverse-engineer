/**
 * Cookie-based Authentication for Google Chat
 * 
 * This method extracts authentication tokens from chat.google.com cookies.
 * You need to:
 * 1. Login to chat.google.com in your browser
 * 2. Export cookies (SAPISID, HSID, SSID, SID, etc.)
 * 3. Paste them here
 * 
 * This is the alternative auth method used by purple-googlechat when
 * OAuth doesn't work.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as readline from 'readline';

const TOKENS_FILE = './tokens.json';

/**
 * Generate SAPISIDHASH for Google API authentication
 * This is required for cookie-based auth
 * 
 * Format: timestamp_sha1(timestamp + " " + SAPISID + " " + origin)
 */
function generateSapisidHash(sapisid, origin = 'https://chat.google.com') {
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${sapisid} ${origin}`;
  const hash = crypto.createHash('sha1').update(input).digest('hex');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

/**
 * Fetch XSRF token and other auth data from chat.google.com
 */
async function fetchXsrfToken(cookies) {
  const url = 'https://chat.google.com/u/0/';
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Cookie': cookies,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch chat.google.com: ${response.status}`);
  }

  const html = await response.text();
  
  // Extract WIZ_global_data which contains XSRF token
  const wizMatch = html.match(/window\.WIZ_global_data\s*=\s*(\{[\s\S]*?\});/);
  if (!wizMatch) {
    // Try alternative pattern
    const xsrfMatch = html.match(/"SNlM0e":"([^"]+)"/);
    if (xsrfMatch) {
      return { xsrf_token: xsrfMatch[1] };
    }
    throw new Error('Could not find WIZ_global_data or XSRF token in page');
  }

  try {
    const wizData = JSON.parse(wizMatch[1]);
    return {
      xsrf_token: wizData.SNlM0e || wizData.SMqcke,
      user_id: wizData.FdrFJe
    };
  } catch (e) {
    throw new Error(`Failed to parse WIZ_global_data: ${e.message}`);
  }
}

/**
 * Parse cookie string from browser
 */
function parseCookieString(cookieStr) {
  const cookies = {};
  cookieStr.split(';').forEach(part => {
    const [key, ...rest] = part.trim().split('=');
    if (key && rest.length) {
      cookies[key.trim()] = rest.join('=').trim();
    }
  });
  return cookies;
}

/**
 * Save tokens to file
 */
function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * Load tokens from file
 */
export function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error loading tokens:', e.message);
  }
  return null;
}

/**
 * Main authentication function
 */
async function authenticate() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  console.log('\n=== Google Chat Cookie Authentication ===\n');
  console.log('This method uses your browser cookies to authenticate.\n');
  console.log('Steps:');
  console.log('1. Open chat.google.com in Chrome and login');
  console.log('2. Open DevTools (F12) → Application → Cookies → https://chat.google.com');
  console.log('3. Copy ALL cookies as a single string (or key ones: SID, HSID, SSID, SAPISID)\n');
  console.log('Or use a browser extension like "EditThisCookie" to export cookies.\n');
  
  console.log('Alternatively, paste the full Cookie header from a network request:\n');

  const cookieInput = await question('Paste your cookies: ');
  rl.close();

  const cookies = cookieInput.trim();
  
  if (!cookies) {
    throw new Error('No cookies provided');
  }

  // Parse cookies to get SAPISID
  const parsedCookies = parseCookieString(cookies);
  const sapisid = parsedCookies['SAPISID'] || parsedCookies['__Secure-1PAPISID'];
  
  if (!sapisid) {
    console.warn('Warning: SAPISID cookie not found. Some requests may fail.');
  }

  console.log('\nFetching authentication tokens from chat.google.com...');

  try {
    const authData = await fetchXsrfToken(cookies);
    
    const tokens = {
      auth_type: 'cookie',
      cookies: cookies,
      sapisid: sapisid,
      xsrf_token: authData.xsrf_token,
      user_id: authData.user_id,
      created_at: Date.now()
    };

    saveTokens(tokens);
    
    console.log('\nAuthentication successful!');
    console.log(`XSRF Token: ${authData.xsrf_token?.substring(0, 20)}...`);
    if (authData.user_id) {
      console.log(`User ID: ${authData.user_id}`);
    }
    console.log('\nTokens saved to tokens.json');
    console.log('You can now run: node index-cookie.js');
    
  } catch (e) {
    console.error('\nAuthentication failed:', e.message);
    console.log('\nMake sure you:');
    console.log('1. Are logged into chat.google.com');
    console.log('2. Copied ALL the cookies correctly');
    process.exit(1);
  }
}

// Export for use in other modules
export { generateSapisidHash, fetchXsrfToken, parseCookieString, saveTokens };

// Run if executed directly
if (process.argv[1].endsWith('auth-cookie.js')) {
  authenticate().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
