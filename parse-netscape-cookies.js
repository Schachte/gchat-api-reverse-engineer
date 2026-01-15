/**
 * Parse Netscape cookie file and setup Google Chat auth
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

const COOKIES_FILE = '/Users/schachte/Downloads/cookies.txt';
const TOKENS_FILE = './tokens.json';

/**
 * Parse Netscape format cookies file
 */
function parseNetscapeCookies(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const cookies = {};
  
  for (const line of content.split('\n')) {
    // Skip comments and empty lines
    if (line.startsWith('#') || !line.trim()) continue;
    
    const parts = line.split('\t');
    if (parts.length >= 7) {
      const [domain, , path, secure, expires, name, value] = parts;
      
      // We want cookies for google.com domains
      if (domain.includes('google.com') || domain.includes('.google.com')) {
        // Store with domain prefix for debugging
        const key = name.trim();
        if (!cookies[key] || domain === '.google.com' || domain === 'chat.google.com') {
          cookies[key] = value.trim();
        }
      }
    }
  }
  
  return cookies;
}

/**
 * Build cookie string for HTTP requests
 */
function buildCookieString(cookies) {
  // Key cookies needed for Google Chat auth
  const importantCookies = [
    'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
    '__Secure-1PSID', '__Secure-3PSID',
    '__Secure-1PAPISID', '__Secure-3PAPISID',
    'OSID', '__Secure-OSID',
    'NID', 'SIDCC', '__Secure-1PSIDCC', '__Secure-3PSIDCC',
    'COMPASS', 'OTZ'
  ];
  
  const parts = [];
  
  // First add important cookies
  for (const key of importantCookies) {
    if (cookies[key]) {
      parts.push(`${key}=${cookies[key]}`);
    }
  }
  
  // Then add any other Google cookies we found
  for (const [key, value] of Object.entries(cookies)) {
    if (!importantCookies.includes(key)) {
      parts.push(`${key}=${value}`);
    }
  }
  
  return parts.join('; ');
}

/**
 * Generate SAPISIDHASH for Google API authentication
 */
function generateSapisidHash(sapisid, origin = 'https://chat.google.com') {
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${sapisid} ${origin}`;
  const hash = crypto.createHash('sha1').update(input).digest('hex');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

/**
 * Fetch XSRF token from chat.google.com
 */
async function fetchXsrfToken(cookieString) {
  console.log('Fetching auth data from chat.google.com...\n');
  
  const response = await fetch('https://chat.google.com/u/0/', {
    method: 'GET',
    headers: {
      'Cookie': cookieString,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow'
  });

  console.log(`Response status: ${response.status}`);
  console.log(`Final URL: ${response.url}`);
  
  const html = await response.text();
  console.log(`HTML length: ${html.length}`);
  
  // Check if we got redirected to login
  if (response.url.includes('accounts.google.com') || html.includes('accounts.google.com/ServiceLogin')) {
    console.log('\nWARNING: Redirected to login page. Cookies may be expired or incomplete.');
  }
  
  // Try multiple patterns for XSRF token
  let xsrfToken = null;
  let userId = null;
  
  // Pattern 1: SNlM0e
  const snlMatch = html.match(/"SNlM0e":"([^"]+)"/);
  if (snlMatch) {
    xsrfToken = snlMatch[1];
    console.log('Found XSRF token via SNlM0e');
  }
  
  // Pattern 2: SMqcke  
  if (!xsrfToken) {
    const smqMatch = html.match(/"SMqcke":"([^"]+)"/);
    if (smqMatch) {
      xsrfToken = smqMatch[1];
      console.log('Found XSRF token via SMqcke');
    }
  }

  // Pattern 3: WIZ_global_data
  if (!xsrfToken) {
    const wizMatch = html.match(/window\.WIZ_global_data\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
    if (wizMatch) {
      try {
        // Clean up the JSON
        let jsonStr = wizMatch[1]
          .replace(/\\x([0-9A-Fa-f]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
        const wizData = JSON.parse(jsonStr);
        xsrfToken = wizData.SNlM0e || wizData.SMqcke;
        userId = wizData.FdrFJe;
        console.log('Found XSRF token via WIZ_global_data');
      } catch (e) {
        console.log('Failed to parse WIZ_global_data:', e.message);
      }
    }
  }

  // Pattern 4: Look for AF_initDataCallback
  if (!xsrfToken) {
    const afMatch = html.match(/AF_initDataCallback\([^)]*"SNlM0e"\s*:\s*"([^"]+)"/);
    if (afMatch) {
      xsrfToken = afMatch[1];
      console.log('Found XSRF token via AF_initDataCallback');
    }
  }

  // Get user ID
  if (!userId) {
    const userIdMatch = html.match(/"FdrFJe"\s*:\s*"(\d+)"/);
    if (userIdMatch) {
      userId = userIdMatch[1];
    }
  }

  return { xsrfToken, userId, htmlLength: html.length };
}

async function main() {
  console.log('=== Parsing Netscape Cookies File ===\n');
  
  // Parse cookies
  const cookies = parseNetscapeCookies(COOKIES_FILE);
  
  console.log('Found Google cookies:');
  const keysToPrint = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-1PAPISID', 'OSID'];
  for (const key of keysToPrint) {
    console.log(`  ${key}: ${cookies[key] ? 'Present' : 'MISSING'}`);
  }
  console.log();
  
  // Build cookie string
  const cookieString = buildCookieString(cookies);
  console.log(`Cookie string length: ${cookieString.length}\n`);

  // Get SAPISID for auth header
  const sapisid = cookies['SAPISID'] || cookies['__Secure-1PAPISID'];
  if (!sapisid) {
    console.error('ERROR: No SAPISID cookie found!');
  } else {
    console.log(`SAPISID found: ${sapisid.substring(0, 20)}...`);
  }

  // Fetch XSRF token
  try {
    const authData = await fetchXsrfToken(cookieString);
    
    console.log('\nAuth data extracted:');
    console.log('- XSRF Token:', authData.xsrfToken ? `${authData.xsrfToken.substring(0, 30)}...` : 'NOT FOUND');
    console.log('- User ID:', authData.userId || 'Not found');

    // Save tokens
    const tokens = {
      auth_type: 'cookie',
      cookies: cookieString,
      sapisid: sapisid,
      xsrf_token: authData.xsrfToken,
      user_id: authData.userId,
      created_at: Date.now()
    };

    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    console.log('\nTokens saved to tokens.json');
    
    if (authData.xsrfToken) {
      console.log('\nRun: node index-cookie.js');
    } else {
      console.log('\nWARNING: No XSRF token found. The client may not work.');
    }
    
  } catch (e) {
    console.error('Error:', e.message);
    console.error(e.stack);
  }
}

main();
