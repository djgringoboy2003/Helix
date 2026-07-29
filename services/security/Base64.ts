// Base64 <-> bytes without depending on `atob`/`Buffer`.
//
// Chunked file reads go through `expo-file-system`, which only returns binary
// data as base64 strings, and the hashing/archive scanners need real bytes.
// Hermes exposes `atob` on newer React Native versions but not reliably on the
// ones this app still supports, so the decode stays local and testable.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const DECODE_TABLE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  // URL-safe aliases; MakerWorld and Moonraker both emit these in places.
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

export class Base64Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Base64Error';
  }
}

/**
 * Decodes base64 (standard or URL-safe) to bytes. Whitespace is ignored;
 * anything else outside the alphabet is rejected rather than skipped, so a
 * truncated or corrupted read fails loudly instead of hashing bad data.
 */
export function base64ToBytes(input: string): Uint8Array {
  let payload = input;
  const padIndex = payload.indexOf('=');
  if (padIndex >= 0) {
    const tail = payload.slice(padIndex);
    if (!/^={1,2}\s*$/.test(tail)) throw new Base64Error('Misplaced base64 padding.');
    payload = payload.slice(0, padIndex);
  }

  const symbols: number[] = [];
  for (let i = 0; i < payload.length; i += 1) {
    const code = payload.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) continue;
    const value = code < 128 ? DECODE_TABLE[code] : -1;
    if (value < 0) throw new Base64Error(`Invalid base64 character at index ${i}.`);
    symbols.push(value);
  }

  if (symbols.length % 4 === 1) throw new Base64Error('Truncated base64 input.');

  const out = new Uint8Array(Math.floor((symbols.length * 3) / 4));
  let outIndex = 0;
  let accumulator = 0;
  let bits = 0;
  for (const symbol of symbols) {
    accumulator = (accumulator << 6) | symbol;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (accumulator >> bits) & 0xff;
      outIndex += 1;
    }
  }

  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += i + 1 < bytes.length ? ALPHABET[(((b1 ?? 0) & 0x0f) << 2) | ((b2 ?? 0) >> 6)] : '=';
    out += i + 2 < bytes.length ? ALPHABET[(b2 ?? 0) & 0x3f] : '=';
  }
  return out;
}

/** UTF-8 encode without relying on `TextEncoder` being present. */
export function utf8ToBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return Uint8Array.from(out);
}
