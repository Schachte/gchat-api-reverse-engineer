/**
 * Google Chat Authentication - Following purple-googlechat implementation
 * 
 * Auth Flow:
 * 1. OAuth2 authorization code -> access_token + refresh_token + id_token
 * 2. id_token -> Dynamite token (via oauthaccountmanager.googleapis.com/v1/issuetoken)
 * 3. Dynamite token -> Used as Bearer token for Chat API calls
 * 
 * OR (Cookie-based):
 * 1. Use browser cookies to fetch XSRF token from chat.google.com/mole/world
 * 2. Use XSRF token + cookies for batchexecute API calls
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as http from 'http';
import open from 'open';

// Constants from libgooglechat.h
const GOOGLE_CLIENT_ID = '936475272427.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = 'KWsJlkaMn1jGLxQpWxMnOox-';
const GOOGLECHAT_API_OAUTH2_TOKEN_URL = 'https://www.googleapis.com/oauth2/v4/token';
const GOOGLECHAT_API_OAUTH2_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

// Dynamite token exchange
const DYNAMITE_CLIENT_ID = '576267593750-sbi1m7khesgfh1e0f2nv5vqlfa4qr72m.apps.googleusercontent.com';
const DYNAMITE_SCOPES = [
  'https://www.googleapis.com/auth/dynamite',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/mobiledevicemanagement',
  'https://www.googleapis.com/auth/notifications',
  'https://www.googleapis.com/auth/supportcontent',
  'https://www.googleapis.com/auth/chat.integration',
  'https://www.googleapis.com/auth/peopleapi.readonly'
].join(' ');

const TOKENS_FILE = './tokens.json';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/**
 * Build OAuth2 authorization URL
 */
function getAuthorizationUrl() {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.google.com/accounts/OAuthLogin',
    redirect_uri: GOOGLECHAT_API_OAUTH2_REDIRECT_URI,
    response_type: 'code',
    device_name: 'purple-googlechat'
  });
  
  return `https://accounts.google.com/o/oauth2/auth?${params}`;
}

/**
 * Exchange authorization code for tokens
 * From: googlechat_oauth_with_code()
 */
async function exchangeCodeForTokens(authCode) {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code: authCode,
    redirect_uri: GOOGLECHAT_API_OAUTH2_REDIRECT_URI,
    grant_type: 'authorization_code'
  });

  const response = await fetch(GOOGLECHAT_API_OAUTH2_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT
    },
    body: body.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} - ${text}`);
  }

  const data = await response.json();
  
  return {
    access_token: data.access_token,
    id_token: data.id_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in
  };
}

/**
 * Refresh the access token using refresh_token
 * From: googlechat_oauth_refresh_token()
 */
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const response = await fetch(GOOGLECHAT_API_OAUTH2_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT
    },
    body: body.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${response.status} - ${text}`);
  }

  const data = await response.json();
  
  return {
    access_token: data.access_token,
    id_token: data.id_token || null, // May not be returned on refresh
    expires_in: data.expires_in
  };
}

/**
 * Exchange id_token for Dynamite token
 * From: googlechat_auth_get_dynamite_token()
 * 
 * This is the key step - exchanges the OAuth id_token for a Dynamite-specific token
 */
async function getDynamiteToken(idToken) {
  const body = new URLSearchParams({
    app_id: 'com.google.Dynamite',
    client_id: DYNAMITE_CLIENT_ID,
    passcode_present: 'YES',
    response_type: 'token',
    scope: DYNAMITE_SCOPES
  });

  const response = await fetch('https://oauthaccountmanager.googleapis.com/v1/issuetoken', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT
    },
    body: body.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dynamite token exchange failed: ${response.status} - ${text}`);
  }

  const data = await response.json();
  
  return {
    token: data.token,
    expiresIn: data.expiresIn
  };
}

/**
 * Get XSRF token from chat.google.com (cookie-based auth)
 * From: googlechat_auth_refresh_xsrf_token()
 */
async function getXsrfToken(cookies) {
  const params = new URLSearchParams({
    origin: 'https://mail.google.com',
    shell: '9',
    hl: 'en',
    wfi: 'gtn-roster-iframe-id',
    hs: JSON.stringify(["h_hs",null,null,[1,0],null,null,"gmail.pinto-server_20230730.06_p0",1,null,[15,38,36,35,26,30,41,18,24,11,21,14,6],null,null,"3Mu86PSulM4.en..es5",0,null,null,[0]])
  });

  const url = `https://chat.google.com/mole/world?${params}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Cookie': cookies,
      'Referer': 'https://mail.google.com/',
      'User-Agent': USER_AGENT
    },
    redirect: 'manual'
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location?.includes('accounts.google.com')) {
      throw new Error('Not authenticated - redirected to login');
    }
  }

  if (!response.ok && response.status !== 302) {
    throw new Error(`Failed to get XSRF token: ${response.status}`);
  }

  const html = await response.text();

  // Parse WIZ_global_data from the response
  // From: googlechat_auth_refresh_xsrf_token_cb()
  const wizMatch = html.match(/>window\.WIZ_global_data = ({.*?});<\/script>/s);
  
  if (!wizMatch) {
    // Save for debugging
    fs.writeFileSync('/tmp/chat_mole_response.html', html);
    throw new Error('Could not find WIZ_global_data in response');
  }

  try {
    const wizData = JSON.parse(wizMatch[1]);
    
    // Check if we're signed in
    const signinUiType = wizData['qwAQke'];
    if (signinUiType === 'AccountsSignInUi') {
      throw new Error('Not signed in - need to authenticate');
    }

    const xsrfToken = wizData['SMqcke'];
    const sapisidCookie = wizData['WZsZ1e'];

    if (!xsrfToken) {
      throw new Error('No XSRF token found in WIZ_global_data');
    }

    return {
      xsrf_token: xsrfToken,
      sapisid: sapisidCookie
    };
  } catch (e) {
    if (e.message.includes('Not signed in') || e.message.includes('No XSRF')) {
      throw e;
    }
    throw new Error(`Failed to parse WIZ_global_data: ${e.message}`);
  }
}

/**
 * Save tokens to file
 */
function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  console.log('Tokens saved to', TOKENS_FILE);
}

/**
 * Load tokens from file
 */
function loadTokens() {
  if (fs.existsSync(TOKENS_FILE)) {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
  }
  return null;
}

/**
 * Complete OAuth flow - opens browser for user to authorize
 */
async function doOAuthFlow() {
  const authUrl = getAuthorizationUrl();
  
  console.log('\n=== OAuth Authorization ===\n');
  console.log('Opening browser for Google authorization...');
  console.log('If browser does not open, visit this URL:\n');
  console.log(authUrl);
  console.log();

  // Open browser
  await open(authUrl);

  // Wait for user to enter the code
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve, reject) => {
    rl.question('Enter the authorization code: ', async (code) => {
      rl.close();
      
      try {
        console.log('\nExchanging code for tokens...');
        const tokens = await exchangeCodeForTokens(code.trim());
        
        console.log('Getting Dynamite token...');
        const dynamite = await getDynamiteToken(tokens.id_token);
        
        const result = {
          ...tokens,
          dynamite_token: dynamite.token,
          dynamite_expires_in: dynamite.expiresIn,
          timestamp: Date.now()
        };
        
        saveTokens(result);
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Ensure we have valid tokens, refreshing if necessary
 */
async function ensureValidTokens() {
  let tokens = loadTokens();
  
  if (!tokens || !tokens.refresh_token) {
    console.log('No tokens found, starting OAuth flow...');
    return doOAuthFlow();
  }

  // Check if tokens are expired (with 5 minute buffer)
  const expiresAt = tokens.timestamp + (tokens.expires_in * 1000);
  const now = Date.now();
  
  if (now >= expiresAt - 300000) {
    console.log('Tokens expired, refreshing...');
    
    try {
      const refreshed = await refreshAccessToken(tokens.refresh_token);
      
      // Get new dynamite token
      const idToken = refreshed.id_token || tokens.id_token;
      const dynamite = await getDynamiteToken(idToken);
      
      tokens = {
        ...tokens,
        access_token: refreshed.access_token,
        id_token: idToken,
        dynamite_token: dynamite.token,
        dynamite_expires_in: dynamite.expiresIn,
        expires_in: refreshed.expires_in,
        timestamp: Date.now()
      };
      
      saveTokens(tokens);
    } catch (e) {
      console.error('Token refresh failed:', e.message);
      console.log('Starting new OAuth flow...');
      return doOAuthFlow();
    }
  }

  return tokens;
}

/**
 * Main entry point
 */
async function main() {
  console.log('=== Google Chat Authentication ===\n');
  console.log('Following purple-googlechat auth implementation\n');
  
  try {
    const tokens = await ensureValidTokens();
    
    console.log('\n=== Authentication Successful ===\n');
    console.log('Access Token:', tokens.access_token?.substring(0, 30) + '...');
    console.log('ID Token:', tokens.id_token?.substring(0, 30) + '...');
    console.log('Dynamite Token:', tokens.dynamite_token?.substring(0, 30) + '...');
    console.log('Refresh Token:', tokens.refresh_token?.substring(0, 30) + '...');
    
    return tokens;
  } catch (e) {
    console.error('\nAuthentication failed:', e.message);
    process.exit(1);
  }
}

// Export for use in other modules
export {
  ensureValidTokens,
  getDynamiteToken,
  getXsrfToken,
  refreshAccessToken,
  loadTokens,
  saveTokens,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  DYNAMITE_CLIENT_ID,
  USER_AGENT
};

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
