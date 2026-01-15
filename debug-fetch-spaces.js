/**
 * Debug script to fetch Google Chat spaces using cookie-based auth
 * Testing different request formats to find what works
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

const TOKENS_FILE = './tokens.json';

// Load tokens
const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
console.log('=== Debug: Fetch Google Chat Spaces ===\n');
console.log('Auth type:', tokens.auth_type);
console.log('XSRF token:', tokens.xsrf_token?.substring(0, 40) + '...');
console.log('SAPISID:', tokens.sapisid ? 'present' : 'MISSING');

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
 * Make an API request to Google Chat
 */
async function chatApiRequest(endpoint, body, contentType = 'application/json+protobuf') {
  const url = `https://chat.google.com/u/0${endpoint}`;

  const headers = {
    'Cookie': tokens.cookies,
    'x-framework-xsrf-token': tokens.xsrf_token,
    'Content-Type': contentType,
    'X-Goog-Encode-Response-If-Executable': 'base64',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://chat.google.com',
    'Referer': 'https://chat.google.com/',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // Add SAPISIDHASH if we have SAPISID
  if (tokens.sapisid) {
    headers['Authorization'] = generateSapisidHash(tokens.sapisid);
  }

  console.log(`\n--- Request: POST ${endpoint} ---`);
  console.log(`Content-Type: ${contentType}`);
  console.log(`Body: ${body.substring(0, 200)}`);

  const fetchOptions = {
    method: 'POST',
    headers,
    body: body,
  };

  try {
    const response = await fetch(url, fetchOptions);

    console.log(`Response: ${response.status} ${response.statusText}`);

    const text = await response.text();

    // Try to decode if base64
    let decoded = text;
    if (text.match(/^[A-Za-z0-9+/=]+$/) && text.length > 20) {
      try {
        decoded = Buffer.from(text, 'base64').toString('utf-8');
        console.log('(base64 decoded)');
      } catch (e) {
        // Not base64
      }
    }

    // Try to parse as JSON
    try {
      const jsonStr = decoded.startsWith(")]}'") ? decoded.slice(5) : decoded;
      const json = JSON.parse(jsonStr);
      console.log('Response (JSON):');
      console.log(JSON.stringify(json, null, 2).substring(0, 3000));
      return { ok: response.ok, status: response.status, data: json };
    } catch (e) {
      console.log('Response (raw):');
      console.log(decoded.substring(0, 500));
      return { ok: response.ok, status: response.status, data: decoded };
    }
  } catch (e) {
    console.error('Fetch error:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Try different formats
 */
async function main() {
  // Format 1: JSON array format (what browser might use)
  console.log('\n========================================');
  console.log('TEST 1: JSON array format (browser style)');
  console.log('========================================');

  // The browser sends requests as JSON arrays
  // Format: [[requestHeader], [requestBody]]
  const arrayBody = JSON.stringify([
    [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 3, "en"]
  ]);
  await chatApiRequest('/api/get_self_user_status', arrayBody, 'application/json+protobuf');

  // Format 2: Simple empty request
  console.log('\n========================================');
  console.log('TEST 2: Empty array');
  console.log('========================================');
  await chatApiRequest('/api/get_self_user_status', '[]', 'application/json+protobuf');

  // Format 3: Protobuf-style JSON with numbered fields
  console.log('\n========================================');
  console.log('TEST 3: Protobuf-style numbered fields');
  console.log('========================================');
  await chatApiRequest('/api/get_self_user_status', JSON.stringify([{"1":{"2":3,"4":"en"}}]), 'application/json+protobuf');

  // Format 4: Try the rpc endpoint format
  console.log('\n========================================');
  console.log('TEST 4: Try batchexecute endpoint (what web client uses)');
  console.log('========================================');

  // The web client uses /_/DynamiteWebUi/data/batchexecute
  const batchUrl = 'https://chat.google.com/_/DynamiteWebUi/data/batchexecute';

  // Format for batchexecute
  const rpcid = 'UVNwGe'; // GetSelfUserStatus RPC ID
  const innerRequest = JSON.stringify([null, null, [3, null, null, "en"]]);
  const batchBody = new URLSearchParams({
    'f.req': JSON.stringify([[
      [rpcid, innerRequest, null, "generic"]
    ]]),
    'at': tokens.xsrf_token
  }).toString();

  const batchHeaders = {
    'Cookie': tokens.cookies,
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Origin': 'https://chat.google.com',
    'Referer': 'https://chat.google.com/',
    'X-Same-Domain': '1',
  };

  if (tokens.sapisid) {
    batchHeaders['Authorization'] = generateSapisidHash(tokens.sapisid);
  }

  console.log(`\n--- Request: POST /_/DynamiteWebUi/data/batchexecute ---`);
  console.log('Using batchexecute format');

  try {
    const response = await fetch(batchUrl, {
      method: 'POST',
      headers: batchHeaders,
      body: batchBody,
    });

    console.log(`Response: ${response.status} ${response.statusText}`);
    const text = await response.text();

    // batchexecute responses start with )]}'
    const cleaned = text.startsWith(")]}'") ? text.slice(5) : text;
    console.log('Response preview:');
    console.log(cleaned.substring(0, 1500));
  } catch (e) {
    console.error('Error:', e.message);
  }

  // Format 5: Try /api/get_group_summaries with proper format
  console.log('\n========================================');
  console.log('TEST 5: get_group_summaries (list spaces)');
  console.log('========================================');

  // Try the exact format mautrix uses
  await chatApiRequest('/api/get_group_summaries', JSON.stringify([{"2":50}]), 'application/json+protobuf');

  console.log('\n\n=== Debug complete ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
