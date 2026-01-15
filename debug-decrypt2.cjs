const crypto = require('crypto');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Chrome v10 uses AES-128-CBC with:
// - 3 byte version prefix "v10"
// - 12 byte nonce (for GCM mode in newer versions, but v10 uses CBC)
// - The rest is ciphertext
// - No separate IV - uses all-space IV for CBC

// Actually, newer Chrome uses AES-256-GCM with "v10" prefix:
// - 3 bytes: "v10"
// - 12 bytes: nonce
// - remaining: ciphertext + 16 byte auth tag

async function main() {
  const password = execSync('security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"', { encoding: 'utf-8' }).trim();
  console.log('Password:', password);

  // For AES-256-GCM, Chrome uses PBKDF2 with SHA1 to derive 256-bit key
  const salt = Buffer.from('saltysalt');
  const key128 = crypto.pbkdf2Sync(password, salt, 1003, 16, 'sha1');
  const key256 = crypto.pbkdf2Sync(password, salt, 1003, 32, 'sha1');
  
  console.log('Key128:', key128.toString('hex'));
  console.log('Key256:', key256.toString('hex'));

  const CHROME_COOKIE_PATH = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default/Cookies');
  const tempPath = '/tmp/chrome_cookies_test.db';
  fs.copyFileSync(CHROME_COOKIE_PATH, tempPath);

  const db = new Database(tempPath, { readonly: true });
  const row = db.prepare("SELECT encrypted_value FROM cookies WHERE name = 'SID' AND host_key = '.google.com'").get();
  db.close();
  fs.unlinkSync(tempPath);

  const encryptedValue = row.encrypted_value;
  console.log('\nEncrypted value total length:', encryptedValue.length);
  console.log('Raw bytes (first 30):', encryptedValue.slice(0, 30).toString('hex'));

  // v10 format: "v10" + 12-byte nonce + ciphertext + 16-byte tag
  const version = encryptedValue.slice(0, 3).toString('ascii');
  console.log('\nVersion:', version);

  if (version === 'v10') {
    // Try AES-256-GCM approach (Chrome 80+)
    const nonce = encryptedValue.slice(3, 15);
    const ciphertextWithTag = encryptedValue.slice(15);
    const ciphertext = ciphertextWithTag.slice(0, -16);
    const authTag = ciphertextWithTag.slice(-16);
    
    console.log('Nonce (12 bytes):', nonce.toString('hex'));
    console.log('Ciphertext length:', ciphertext.length);
    console.log('Auth tag:', authTag.toString('hex'));

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key256, nonce);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      console.log('\n=== SUCCESS with AES-256-GCM ===');
      console.log('Decrypted:', decrypted.toString('utf-8'));
    } catch (e) {
      console.log('\nAES-256-GCM failed:', e.message);
      
      // Try with 128-bit key
      try {
        // Chrome actually might use AES-128-GCM
        const key128gcm = crypto.pbkdf2Sync(password, salt, 1003, 16, 'sha1');
        const decipher2 = crypto.createDecipheriv('aes-128-gcm', key128gcm, nonce);
        decipher2.setAuthTag(authTag);
        const decrypted2 = Buffer.concat([decipher2.update(ciphertext), decipher2.final()]);
        console.log('\n=== SUCCESS with AES-128-GCM ===');
        console.log('Decrypted:', decrypted2.toString('utf-8'));
      } catch (e2) {
        console.log('AES-128-GCM failed:', e2.message);
      }
    }
    
    // Also try the old CBC approach with all 0 IV
    console.log('\n--- Trying CBC with zero IV ---');
    try {
      const dataForCbc = encryptedValue.slice(3);
      const iv = Buffer.alloc(16, 0);
      const decipher3 = crypto.createDecipheriv('aes-128-cbc', key128, iv);
      decipher3.setAutoPadding(true);
      const decrypted3 = Buffer.concat([decipher3.update(dataForCbc), decipher3.final()]);
      console.log('CBC with zero IV:', decrypted3.toString('utf-8').substring(0, 100));
    } catch (e) {
      console.log('CBC zero IV failed:', e.message);
    }
  }
}

main();
