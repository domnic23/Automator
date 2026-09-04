// PrivateBin v2 paste: fetch, decrypt, extract download links.
//
// The server only ever returns ciphertext. The decryption key lives in the URL
// fragment (after '#') and is never sent to the server, so we must decrypt
// locally. Verified working against paste.fitgirl-repacks.site.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { safeFilename, safeUrl } from './safe.js';

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Guard against a decompression bomb in attacker-supplied ciphertext.
const MAX_INFLATED_BYTES = 50 * 1024 * 1024;

export class PasteError extends Error {
  constructor(stage, message) {
    super(`[${stage}] ${message}`);
    this.stage = stage;
  }
}

function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new PasteError('key', `invalid base58 character "${ch}"`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;

  let leadingZeros = 0;
  for (const ch of str) {
    if (ch === '1') leadingZeros++;
    else break;
  }
  return Buffer.concat([
    Buffer.alloc(leadingZeros),
    Buffer.from(hex, 'hex'),
  ]);
}

function inflateBounded(buf) {
  const out = zlib.inflateRawSync(buf, { maxOutputLength: MAX_INFLATED_BYTES });
  return out;
}

/** Split "https://host/?id#key" into its base URL and its fragment key. */
export function splitPasteUrl(url) {
  const hashAt = url.indexOf('#');
  if (hashAt < 0) {
    throw new PasteError('url', 'paste URL has no "#key" fragment');
  }
  const base = url.slice(0, hashAt);
  const key = url.slice(hashAt + 1);
  if (!key) throw new PasteError('url', 'paste URL fragment is empty');
  if (!safeUrl(base)) throw new PasteError('url', 'paste URL is not http(s)');
  return { base, key };
}

async function fetchPasteJson(base) {
  let res;
  try {
    res = await fetch(base, {
      headers: {
        'X-Requested-With': 'JSONHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });
  } catch (err) {
    throw new PasteError('fetch', `network error: ${err.message}`);
  }
  if (!res.ok) throw new PasteError('fetch', `HTTP ${res.status}`);

  let json;
  try {
    json = await res.json();
  } catch {
    throw new PasteError('fetch', 'response was not JSON (site layout changed?)');
  }
  if (json.status !== 0) {
    throw new PasteError('fetch', `paste not available (status ${json.status})`);
  }
  return json;
}

/** Decrypt a PrivateBin v2 payload into its plain text body. */
export function decryptPaste(json, fragmentKey, password = '') {
  if (json.v !== 2) {
    throw new PasteError('format', `expected PrivateBin v2, got v${json.v}`);
  }
  const spec = json.adata?.[0];
  if (!Array.isArray(spec) || spec.length < 8) {
    throw new PasteError('format', 'unrecognised adata block');
  }
  const [ivB64, saltB64, iterations, keyBits, tagBits, cipher, mode, compression] =
    spec;

  if (cipher !== 'aes' || mode !== 'gcm') {
    throw new PasteError('format', `unsupported cipher ${cipher}-${mode}`);
  }
  if (compression !== 'zlib' && compression !== 'none') {
    throw new PasteError('format', `unsupported compression ${compression}`);
  }
  if (keyBits !== 256) {
    throw new PasteError('format', `unsupported key size ${keyBits}`);
  }

  const key = crypto.pbkdf2Sync(
    Buffer.concat([base58Decode(fragmentKey), Buffer.from(password, 'utf8')]),
    Buffer.from(saltB64, 'base64'),
    iterations,
    keyBits / 8,
    'sha256',
  );

  const payload = Buffer.from(json.ct, 'base64');
  const tagLen = tagBits / 8;
  if (payload.length <= tagLen) {
    throw new PasteError('decrypt', 'ciphertext too short');
  }

  let plain;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivB64, 'base64'),
      { authTagLength: tagLen },
    );
    decipher.setAAD(Buffer.from(JSON.stringify(json.adata), 'utf8'));
    decipher.setAuthTag(payload.subarray(payload.length - tagLen));
    plain = Buffer.concat([
      decipher.update(payload.subarray(0, payload.length - tagLen)),
      decipher.final(),
    ]);
  } catch (err) {
    throw new PasteError(
      'decrypt',
      `wrong key or password (${err.message})`,
    );
  }

  if (compression === 'zlib') {
    try {
      plain = inflateBounded(plain);
    } catch (err) {
      throw new PasteError('decrypt', `inflate failed: ${err.message}`);
    }
  }

  try {
    return JSON.parse(plain.toString('utf8')).paste;
  } catch {
    throw new PasteError('decrypt', 'decrypted body was not PrivateBin JSON');
  }
}

/**
 * Pull download links out of the decrypted body.
 * Each entry: { url, filename, hostPage: true }.
 * Filenames come from the URL fragment when the host provides one there.
 */
export function extractLinks(text) {
  const found = [];
  const seen = new Set();

  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const raw = match[0].replace(/[.,;]+$/, '');
    const url = safeUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const u = new URL(url);
    const hint = u.hash ? u.hash.slice(1) : u.pathname.split('/').pop();
    found.push({
      url,
      filename: safeFilename(hint) ?? `download_${found.length + 1}`,
    });
  }
  return found;
}

/** Fetch + decrypt + extract, in one call. */
export async function loadPaste(pasteUrl, password = '') {
  const { base, key } = splitPasteUrl(pasteUrl);
  const json = await fetchPasteJson(base);
  const text = decryptPaste(json, key, password);
  return { text, links: extractLinks(text) };
}
