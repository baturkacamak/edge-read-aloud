/**
 * Sec-MS-GEC v2 token generation for Microsoft Edge's Read Aloud service.
 *
 * Since 10 October 2026 the service rejects the old v1 token (plain SHA-256)
 * with HTTP 403. v2 tokens look like `<16 hex>-<64 hex>`:
 *
 *   payload = `<windows-file-time-ticks><trusted-client-token>`
 *   sha256  = SHA-256("Copyright (C) Microsoft Corporation. All rights reserved." + payload)
 *   cs64    = custom 64-bit checksum over `payload`, keyed by `sha256`
 *   token   = `<cs64 hex>-<sha256 hex>`
 *
 * The algorithm is ported from rany2/edge-tts (GPL-3.0), src/edge_tts/drm.py.
 * This file is part of a GPL-3.0 project; see LICENSE and NOTICE.
 */

export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

// Only the "2-" prefix is validated by the service; the version after it is
// ignored. Keeping it in sync with Edge stable avoids surprises.
export const EDGE_CHROMIUM_VERSION = "143.0.3650.75";
export const SEC_MS_GEC_VERSION = `2-${EDGE_CHROMIUM_VERSION}`;

// 57 bytes, ends with 0x2E ('.').
export const TOKEN_HASH_PREFIX =
  "Copyright (C) Microsoft Corporation. All rights reserved.";

const WIN_EPOCH = 11644473600;
const TOKEN_WINDOW_SECONDS = 300;

let clockSkewSeconds = 0;

export function adjustClockSkew(seconds) {
  clockSkewSeconds += seconds;
}

export function currentUnixTimestamp() {
  return Date.now() / 1000 + clockSkewSeconds;
}

const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

// [coefficient, offset] pairs from the native implementation.
const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];

const U32 = 0xffffffff;

function rol16(value) {
  value >>>= 0;
  return ((value << 16) | (value >>> 16)) >>> 0;
}

function mul(a, b) {
  return Math.imul(a, b) >>> 0;
}

/** Split bytes into little-endian 32-bit words, zero-padded to an even count. */
function wordsLE4Even(bytes) {
  const paddedLength = (bytes.length + 3) & ~3;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  const view = new DataView(padded.buffer);
  const words = [];
  for (let i = 0; i < paddedLength; i += 4) {
    words.push(view.getUint32(i, true));
  }
  if (words.length % 2) words.push(0);
  return words;
}

/** CS64 checksum over `data`, keyed by the first 8 bytes of `digest`. */
function cs64Digest(data, digest) {
  const digestView = new DataView(
    digest.buffer,
    digest.byteOffset,
    digest.byteLength
  );
  const keyA = (digestView.getUint32(0, true) | 1) >>> 0;
  const keyB = (digestView.getUint32(4, true) | 1) >>> 0;

  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];

  const terms = CS64_COEFFICIENTS.map(([coefficient], index) =>
    mul(coefficient, factors[index % 2])
  );
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset >>> 0);

  // A leading zero byte shifts the payload so the native code reads the token
  // window the same way.
  const shifted = new Uint8Array(data.length + 1);
  shifted.set(data, 1);

  wordsLE4Even(shifted).forEach((word, index) => {
    let term = mul(word, index % 2 === 0 ? keyA : keyB);
    let offset = mul(
      rol16(word),
      index % 2 === 0 ? 0xef0569fb : 0xc31713db
    );
    if (index === 0) {
      term = (term + mul(CS64_ADJUSTMENT0, factors[0])) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  });

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;

  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];

    let t = rol16((offsets[index] + x) >>> 0);
    let q = mul(t, 0x76f50f34);
    swapAcc = (swapAcc + ((mul(rol16(q), 0xc3efea97) + q) >>> 0)) >>> 0;

    t = rol16((offsets[index + 1] + y) >>> 0);
    q = mul(t, 0x1881ce3c);
    swapLast = (mul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (mul(state, keyA) + x) >>> 0;
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc = (acc + state) >>> 0;

    t = (mul(state, keyB) + y) >>> 0;
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = (acc + state) >>> 0;
  }

  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

function hexLE(words) {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, true));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * Generate a v2 Sec-MS-GEC token.
 *
 * @param {number} [unixTimestamp] Override the clock (seconds since epoch),
 *   used by tests and clock-skew correction.
 * @returns {Promise<string>} `<16 hex>-<64 hex>`
 */
export async function generateSecMsGecV2(unixTimestamp) {
  let ticks = unixTimestamp ?? currentUnixTimestamp();

  // Match the reference implementation's double arithmetic exactly: at
  // ~1.34e17 the value exceeds 2^53, so the rounded .0f/toFixed(0) output is
  // part of the token.
  ticks += WIN_EPOCH;
  ticks -= ticks % TOKEN_WINDOW_SECONDS;
  ticks *= 1e7;

  const payload = new TextEncoder().encode(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`);
  const prefix = new TextEncoder().encode(TOKEN_HASH_PREFIX);

  const message = new Uint8Array(prefix.length + payload.length);
  message.set(prefix, 0);
  message.set(payload, prefix.length);

  const digest = await crypto.subtle.digest("SHA-256", message);
  const digestBytes = new Uint8Array(digest);

  const cs64 = cs64Digest(payload, digestBytes);
  return `${hexLE(cs64)}-${hex(digestBytes)}`;
}

/** Query string fragment shared by the synthesis WebSocket. */
export async function secMsGecQuery(unixTimestamp) {
  const token = await generateSecMsGecV2(unixTimestamp);
  return `Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
}
