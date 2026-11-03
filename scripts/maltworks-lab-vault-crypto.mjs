#!/usr/bin/env node
// Offline-only AES-256-GCM envelope for transferring lab-only credentials.
// Secrets and passphrase are supplied on stdin; they are never CLI arguments.
// This is not imported by Workers or by customer code.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const LABEL = 'MALTWORKS_LAB_STAGING_PORTABLE_V1';
const MAX_INPUT = 131072;
const N = 32768;
const COST = { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const AAD = Buffer.from(LABEL, 'ascii');

function readBase64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('Invalid encrypted envelope');
  }
  const bytes = Buffer.from(value, 'base64');
  if ((length && bytes.length !== length) || !bytes.length) {
    throw new Error('Invalid encrypted envelope');
  }
  return bytes;
}

export function seal(passphrase, payload) {
  if (typeof passphrase !== 'string' || !/^[\x21-\x7E]{8,128}$/.test(passphrase)) {
    throw new Error('Passphrase must be 8-128 printable ASCII characters without spaces');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid lab credentials');
  }
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, COST);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    try {
      if (plaintext.length > 32768) throw new Error('Lab credential bundle too large');
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        format: LABEL,
        cipher: 'aes-256-gcm',
        kdf: 'scrypt-N32768-r8-p1',
        salt: salt.toString('base64'),
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: encrypted.toString('base64'),
      };
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

export function unseal(passphrase, envelope) {
  if (typeof passphrase !== 'string' || !/^[\x21-\x7E]{8,128}$/.test(passphrase)) {
    throw new Error('Invalid passphrase or encrypted envelope');
  }
  if (!envelope || envelope.format !== LABEL || envelope.cipher !== 'aes-256-gcm' ||
      envelope.kdf !== 'scrypt-N32768-r8-p1') {
    throw new Error('Invalid passphrase or encrypted envelope');
  }
  try {
    const salt = readBase64(envelope.salt, 16);
    const nonce = readBase64(envelope.nonce, 12);
    const tag = readBase64(envelope.tag, 16);
    const encrypted = readBase64(envelope.ciphertext);
    if (encrypted.length > 32768) throw new Error('Invalid envelope');
    const key = scryptSync(passphrase, salt, 32, COST);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      try {
        const value = JSON.parse(plaintext.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Unexpected plaintext');
        }
        return value;
      } finally {
        plaintext.fill(0);
      }
    } finally {
      key.fill(0);
    }
  } catch {
    throw new Error('Invalid passphrase or encrypted envelope');
  }
}

async function main() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT) throw new Error('Input too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  try {
    const input = JSON.parse(raw.toString('utf8'));
    if (input?.mode === 'seal') {
      process.stdout.write(JSON.stringify(seal(input.passphrase, input.payload)) + '\n');
    } else if (input?.mode === 'unseal') {
      process.stdout.write(JSON.stringify(unseal(input.passphrase, input.envelope)) + '\n');
    } else {
      throw new Error('Unknown mode');
    }
  } finally {
    raw.fill(0);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // No passphrase, ciphertext, tokens, or exception input in errors.
    process.stderr.write('Maltworks Lab transfer failed; no credentials displayed.\n');
    process.exitCode = 1;
  });
}
