// AES-128-CBC decryption for HLS segments, using the Web Crypto API. No
// chrome.* APIs here — the key bytes and IV are handed in by the caller — so
// this is unit-testable by round-tripping against crypto.subtle.encrypt.
//
// HLS encrypts each segment with AES-128-CBC and PKCS#7 padding, which is
// exactly what crypto.subtle.decrypt expects, so no manual unpadding is needed.

export async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (keyBytes.byteLength !== 16) {
    throw new Error(`Expected a 16-byte AES-128 key, got ${keyBytes.byteLength} bytes.`);
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-CBC", false, ["decrypt"]);
}

export async function decryptSegment(
  ciphertext: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext)
  );
  return new Uint8Array(plaintext);
}

/** Web Crypto wants a plain ArrayBuffer; a Uint8Array may be a view into a larger buffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
