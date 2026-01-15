const crypto = require('crypto');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  // Get encryption key
  const password = execSync('security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"', { encoding: 'utf-8' }).trim();
  console.log('Password from keychain:', password.substring(0, 10) + '...');

  // Derive key
  const salt = Buffer.from('saltysalt');
  const key = crypto.pbkdf2Sync(password, salt, 1003, 16, 'sha1');
  console.log('Derived key:', key.toString('hex'));

  // Get SID cookie
  const CHROME_COOKIE_PATH = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default/Cookies');
  const tempPath = '/tmp/chrome_cookies_test.db';
  fs.copyFileSync(CHROME_COOKIE_PATH, tempPath);

  const db = new Database(tempPath, { readonly: true });
  const row = db.prepare("SELECT encrypted_value FROM cookies WHERE name = 'SID' AND host_key = '.google.com'").get();
  db.close();
  fs.unlinkSync(tempPath);

  const encryptedValue = row.encrypted_value;
  console.log('Encrypted length:', encryptedValue.length);
  console.log('Prefix bytes:', encryptedValue.slice(0, 5));

  // Remove v10 prefix
  const data = encryptedValue.slice(3);
  console.log('Data length after prefix:', data.length);

  // Try AES-128-CBC with space-filled IV
  const iv = Buffer.alloc(16, 0x20);

  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

    // Manual PKCS7 unpad
    const padLen = decrypted[decrypted.length - 1];
    console.log('Pad length:', padLen);
    
    const unpadded = decrypted.slice(0, decrypted.length - padLen);
    console.log('Unpadded length:', unpadded.length);
    console.log('Decrypted (first 100 chars):', unpadded.toString('utf-8').substring(0, 100));
    console.log('First 20 bytes:', unpadded.slice(0, 20));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
