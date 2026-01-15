/**
 * Setup cookies from user-provided values and fetch XSRF token
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

const TOKENS_FILE = './tokens.json';

// User-provided cookies
const userCookies = {
  "compass": "dynamite-ui=CgAQo4GkywYargEACWuJV4e08mbhVOMepZ9LCPKNqnk02CZ3XuVTiPIjddSBK2l1QhnCEkSJUXXmM-vMeDNCSQMhuBQG2Ora1SsgNVADOcyY7B4y4D3gCJNI7CY8MGjvP2NctfAWd919_eeB9JG-_zVGfE_Fr2tjMmT-mO18Gj-WG-xjvQGpGyJC3RE4aQABtqQMjXsb024VtrZ0PpdxdoYQTOhK9eFKByW9FEehvxEMmYagpo0wjz8gATAB:dynamite-frontend=CgAQtvOjywYarQEACWuJVzCw0UiYL-0ZT60Snw9cZU8ahp_-4D-tIVU915JxFJG96Zjy9ZNvnk_baviIOl6OGwL4az-uWsjv5cHyT8ZZbYsje6HhO7l3tMmACTqnLYDnuKfcu3BJCgwjSa_wjUQyhRKn2F8SfOrj8T1-R2gTNDNkWSxgwzYLUxcODWc_9dW16NKSaYin3-dQpgMRJKL4-rQB63stgf4XXnR_4Vt4rZt8FZ-2r021NTAB:appsfrontendserver=CgAQhPijywYafQAJa4lX5OCCKueGX21oyPTR5cJELnEmvchqyYzy0Ri-6XxnTARw09tf0nT54WPT2KsvPtEfaw02XPhNGPwBWWbUI3KvMg_sox3gorx_m8SbVF10SWiIrVAKo8E7kW6oahWj9wA4av5oErH8NdDSnnXtw6x4mlYuFWS2aoDJIAEwAQ:dynamite-blobstore=CgAQ5b-jywYaiAEACWuJVywerd_1krzEzP6R7YgjhWiyxc_Z_G6JWEN3Iyhw1KIMRWTe3U0LombnJgrQHEurwulMpmbfpC_Xzwo4cAKhqXxz7qLqSFjYXZiajkOqFfMdvW0NCEwAxMoKDUPpoml-CDSOPl8T8HABdkaLNI2YTGZojji5OXJCGZvfhT4mXsWz-LDMMAE",
  "SSID": "APnmV9o9gNAG9ds6c",
  "SID": "g.a0005ghRviiUJeF2ckU5D0qCE9J9PwS1y3SgWmumkbVhZ-F_laGZycd667B3MX8xicxaaZDKmgACgYKAekSARUSFQHGX2Mim6eSdFLW2wdHTq2WJCuU6hoVAUF8yKoDMNZ0Mu5215Vrtcyi4Gjz0076",
  "OSID": "g.a0005ghRvsvqf9rob38DjYGiN773ZLUGWuYb_Eo3tM3z6D6-wshlR-Lm9yjqpnLoC7nZRhsEyQACgYKAToSARUSFQHGX2MiumyaCANLnHtfmE5vRbQu_BoVAUF8yKpoGYcH8MVNtX3pU1_uLFlb0076",
  "HSID": "AVqSHD4FGt8YTzBV6"
};

// Build cookie string
function buildCookieString(cookies) {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

// Generate SAPISIDHASH
function generateSapisidHash(sapisid, origin = 'https://chat.google.com') {
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${sapisid} ${origin}`;
  const hash = crypto.createHash('sha1').update(input).digest('hex');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

// Fetch XSRF token and additional cookies from chat.google.com
async function fetchAuthData(cookieString) {
  console.log('Fetching auth data from chat.google.com...\n');
  
  const response = await fetch('https://chat.google.com/u/0/', {
    method: 'GET',
    headers: {
      'Cookie': cookieString,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'manual'  // Don't follow redirects automatically
  });

  console.log(`Response status: ${response.status}`);
  
  // Check for redirects
  if (response.status === 302 || response.status === 301) {
    const location = response.headers.get('location');
    console.log(`Redirect to: ${location}`);
    
    // Get any set-cookie headers
    const setCookies = response.headers.getSetCookie?.() || [];
    console.log('Set-Cookie headers:', setCookies.length);
    
    // Follow redirect
    const redirectResponse = await fetch(location, {
      method: 'GET',
      headers: {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      redirect: 'follow'
    });
    
    return extractAuthFromHtml(await redirectResponse.text(), redirectResponse);
  }

  return extractAuthFromHtml(await response.text(), response);
}

function extractAuthFromHtml(html, response) {
  // Look for SAPISID in Set-Cookie
  let sapisid = null;
  const setCookies = response.headers.getSetCookie?.() || [];
  for (const cookie of setCookies) {
    const match = cookie.match(/SAPISID=([^;]+)/);
    if (match) {
      sapisid = match[1];
      break;
    }
  }

  // Try multiple patterns for XSRF token
  let xsrfToken = null;
  
  // Pattern 1: SNlM0e in WIZ_global_data
  const snlMatch = html.match(/"SNlM0e":"([^"]+)"/);
  if (snlMatch) {
    xsrfToken = snlMatch[1];
    console.log('Found XSRF token via SNlM0e');
  }
  
  // Pattern 2: SMqcke in WIZ_global_data  
  if (!xsrfToken) {
    const smqMatch = html.match(/"SMqcke":"([^"]+)"/);
    if (smqMatch) {
      xsrfToken = smqMatch[1];
      console.log('Found XSRF token via SMqcke');
    }
  }

  // Pattern 3: Full WIZ_global_data parse
  if (!xsrfToken) {
    const wizMatch = html.match(/window\.WIZ_global_data\s*=\s*(\{[^<]+\})\s*;/);
    if (wizMatch) {
      try {
        const wizData = JSON.parse(wizMatch[1]);
        xsrfToken = wizData.SNlM0e || wizData.SMqcke;
        sapisid = sapisid || wizData.WZsZ1e;
        console.log('Found XSRF token via WIZ_global_data');
      } catch (e) {
        console.log('Failed to parse WIZ_global_data:', e.message);
      }
    }
  }

  // Pattern 4: Look for at= parameter
  if (!xsrfToken) {
    const atMatch = html.match(/['"&]at=([^'"&]+)['"&]/);
    if (atMatch) {
      xsrfToken = decodeURIComponent(atMatch[1]);
      console.log('Found XSRF token via at= parameter');
    }
  }

  // Extract user ID if present
  const userIdMatch = html.match(/"FdrFJe":"(\d+)"/);
  const userId = userIdMatch ? userIdMatch[1] : null;

  return { xsrfToken, sapisid, userId, htmlLength: html.length };
}

async function main() {
  console.log('=== Setting up Google Chat cookies ===\n');
  
  const cookieString = buildCookieString(userCookies);
  console.log('Cookie string length:', cookieString.length);
  console.log('Cookies included:', Object.keys(userCookies).join(', '));
  console.log();

  try {
    const authData = await fetchAuthData(cookieString);
    
    console.log('\nAuth data extracted:');
    console.log('- XSRF Token:', authData.xsrfToken ? `${authData.xsrfToken.substring(0, 30)}...` : 'NOT FOUND');
    console.log('- SAPISID:', authData.sapisid ? 'Found' : 'Not found');
    console.log('- User ID:', authData.userId || 'Not found');
    console.log('- HTML Length:', authData.htmlLength);

    if (!authData.xsrfToken) {
      console.error('\nERROR: Could not find XSRF token.');
      console.log('The page might require additional cookies or a different approach.');
      console.log('\nTrying to save what we have anyway...');
    }

    const tokens = {
      auth_type: 'cookie',
      cookies: cookieString,
      sapisid: authData.sapisid,
      xsrf_token: authData.xsrfToken,
      user_id: authData.userId,
      created_at: Date.now()
    };

    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    console.log('\nTokens saved to tokens.json');
    
    if (authData.xsrfToken) {
      console.log('\nYou can now run: node index-cookie.js');
    }
    
  } catch (e) {
    console.error('Error:', e.message);
    console.error(e.stack);
  }
}

main();
