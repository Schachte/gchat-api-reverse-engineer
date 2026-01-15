/**
 * Google Chat OAuth Authentication
 *
 * This replicates the EXACT auth flow from purple-googlechat:
 * 1. User logs into Google via browser and gets an authorization code
 * 2. Exchange code for refresh_token and id_token
 * 3. Use id_token to get a Dynamite access_token
 * 4. Use Dynamite token for API calls
 *
 * Key difference from typical OAuth: we use the OAuthLogin scope which
 * gives us an id_token that can be exchanged for a Dynamite token.
 */

import open from 'open';
import * as fs from 'fs';
import * as readline from 'readline';

// OAuth constants - EXACTLY as defined in purple-googlechat libgooglechat.h
const GOOGLE_CLIENT_ID = '936475272427.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = 'KWsJlkaMn1jGLxQpWxMnOox-';
const OAUTH2_TOKEN_URL = 'https://www.googleapis.com/oauth2/v4/token';
const OAUTH2_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

// Dynamite token endpoint and credentials from purple-googlechat googlechat_auth.c
const DYNAMITE_TOKEN_URL = 'https://oauthaccountmanager.googleapis.com/v1/issuetoken';
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

/**
 * Build the OAuth authorization URL
 * CRITICAL: Must use the exact scope from purple-googlechat
 * This scope gives us an id_token that works with the Dynamite token exchange
 */
function getAuthorizationUrl() {
  // This is the EXACT URL format from libgooglechat.h
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.google.com/accounts/OAuthLogin',
    redirect_uri: OAUTH2_REDIRECT_URI,
    response_type: 'code',
    device_name: 'purple-googlechat'
  });
  return `https://accounts.google.com/o/oauth2/auth?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 * Returns: { access_token, id_token, refresh_token, ... }
 */
async function exchangeCodeForTokens(authCode) {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code: authCode,
    redirect_uri: OAUTH2_REDIRECT_URI,
    grant_type: 'authorization_code'
  });

  console.log('  POSTing to:', OAUTH2_TOKEN_URL);

  const response = await fetch(OAUTH2_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error('  Response:', responseText);
    throw new Error(`Failed to exchange code: ${response.status} - ${responseText}`);
  }

  const data = JSON.parse(responseText);
  console.log('  Got tokens:', Object.keys(data).join(', '));
  return data;
}

/**
 * Refresh the access token using refresh_token
 * Note: When refreshing, we may not get a new id_token, so we use access_token
 */
export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    // Note: purple-googlechat doesn't send client_secret on refresh
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const response = await fetch(OAUTH2_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${error}`);
  }

  return response.json();
}

/**
 * Get Dynamite token for Google Chat API access
 *
 * This is the key step from googlechat_auth.c:googlechat_auth_get_dynamite_token()
 * The token parameter should be:
 * - id_token from initial OAuth (preferred)
 * - OR access_token from refresh
 *
 * Returns: { token, expiresIn }
 */
export async function getDynamiteToken(idOrAccessToken) {
  const body = new URLSearchParams({
    app_id: 'com.google.Dynamite',
    client_id: DYNAMITE_CLIENT_ID,
    passcode_present: 'YES',
    response_type: 'token',
    scope: DYNAMITE_SCOPES
  });

  console.log('  POSTing to:', DYNAMITE_TOKEN_URL);

  const response = await fetch(DYNAMITE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idOrAccessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error('  Response status:', response.status);
    console.error('  Response:', responseText.substring(0, 500));
    throw new Error(`Failed to get Dynamite token: ${response.status}`);
  }

  const data = JSON.parse(responseText);
  console.log('  Got Dynamite token, expires in:', data.expiresIn);
  return data;
}

/**
 * Load saved tokens from file
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
 * Save tokens to file
 */
export function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * Full authentication flow
 */
async function authenticate() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  console.log('\n=== Google Chat Authentication (purple-googlechat method) ===\n');
  console.log('This uses the same OAuth flow as the Pidgin plugin.\n');
  console.log('Opening browser for Google login...');
  console.log('If browser does not open, visit this URL:\n');

  const authUrl = getAuthorizationUrl();
  console.log(authUrl);
  console.log();

  // Try to open browser
  try {
    await open(authUrl);
  } catch (e) {
    console.log('(Could not open browser automatically)');
  }

  console.log('After logging in, Google will show you an authorization code.');
  console.log('Copy and paste it here.\n');

  const authCode = await question('Enter the authorization code: ');
  rl.close();

  if (!authCode.trim()) {
    throw new Error('No authorization code provided');
  }

  console.log('\n1. Exchanging code for OAuth tokens...');
  const oauthTokens = await exchangeCodeForTokens(authCode.trim());

  // Use id_token for Dynamite exchange (as purple-googlechat does)
  // Fall back to access_token if id_token not available
  const tokenForDynamite = oauthTokens.id_token || oauthTokens.access_token;

  if (!tokenForDynamite) {
    throw new Error('No id_token or access_token in OAuth response');
  }

  console.log('\n2. Getting Dynamite token...');
  const dynamiteTokens = await getDynamiteToken(tokenForDynamite);

  const tokens = {
    refresh_token: oauthTokens.refresh_token,
    id_token: oauthTokens.id_token,
    access_token: oauthTokens.access_token,
    dynamite_token: dynamiteTokens.token,
    dynamite_expires_in: dynamiteTokens.expiresIn,
    created_at: Date.now()
  };

  saveTokens(tokens);

  console.log('\n=== Authentication successful! ===');
  console.log('Tokens saved to tokens.json');
  console.log('\nYou can now run: npm start');
}

/**
 * Ensure we have valid tokens, refreshing if necessary
 */
export async function ensureValidTokens() {
  let tokens = loadTokens();

  if (!tokens || !tokens.refresh_token) {
    throw new Error('No tokens found. Run: npm run auth');
  }

  // Check if dynamite token is still valid (has expiry buffer)
  const now = Date.now();
  const createdAt = tokens.refreshed_at || tokens.created_at || 0;
  const expiresIn = parseInt(tokens.dynamite_expires_in) || 3600;
  const expiryTime = createdAt + (expiresIn * 1000);

  // Refresh if token expires in less than 5 minutes
  if (expiryTime - now < 5 * 60 * 1000) {
    console.log('Refreshing access token...');
    const refreshed = await refreshAccessToken(tokens.refresh_token);

    // Use the new access_token to get a fresh Dynamite token
    // Note: refresh response might have id_token in some cases
    const tokenForDynamite = refreshed.access_token;

    console.log('Getting Dynamite token...');
    const dynamiteTokens = await getDynamiteToken(tokenForDynamite);

    tokens = {
      ...tokens,
      id_token: refreshed.id_token || tokens.id_token,
      access_token: refreshed.access_token,
      dynamite_token: dynamiteTokens.token,
      dynamite_expires_in: dynamiteTokens.expiresIn,
      refreshed_at: Date.now()
    };

    saveTokens(tokens);
  } else {
    console.log('Using cached Dynamite token (still valid)');
  }

  return tokens;
}

// Run authentication if this file is executed directly
const isMainModule = process.argv[1]?.endsWith('auth.js') ||
                     process.argv[1]?.includes('auth.js');

if (isMainModule) {
  authenticate().catch(err => {
    console.error('\nAuthentication failed:', err.message);
    console.error('\nIf you see "device_id or auth_extension is required", the OAuth');
    console.error('client may be blocked. Try the cookie-based auth instead:');
    console.error('  node auth-cookie.js');
    process.exit(1);
  });
}
