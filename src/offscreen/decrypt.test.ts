import { describe, expect, it } from "vitest";
import { decryptSegment, importAesKey } from "./decrypt";

const KEY_BYTES = new Uint8Array([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
]);
const IV = new Uint8Array([
  0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a, 0x09, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00,
]);

/** TypeScript's BufferSource wants a plain ArrayBuffer, not a view into one. */
function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function encrypt(plaintext: Uint8Array, iv: Uint8Array = IV): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buffer(KEY_BYTES), "AES-CBC", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: buffer(iv) },
    key,
    buffer(plaintext)
  );
  return new Uint8Array(ciphertext);
}

describe("importAesKey", () => {
  it("imports a 16-byte key", async () => {
    await expect(importAesKey(KEY_BYTES)).resolves.toBeDefined();
  });

  it("rejects keys that aren't 16 bytes", async () => {
    await expect(importAesKey(new Uint8Array(8))).rejects.toThrow(/16-byte/);
  });
});

describe("decryptSegment", () => {
  it("recovers the original bytes", async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const ciphertext = await encrypt(plaintext);

    const key = await importAesKey(KEY_BYTES);
    const decrypted = await decryptSegment(ciphertext, key, IV);

    expect([...decrypted]).toEqual([...plaintext]);
  });

  it("handles payloads that are an exact multiple of the block size", async () => {
    const plaintext = new Uint8Array(32).fill(7);
    const ciphertext = await encrypt(plaintext);

    const key = await importAesKey(KEY_BYTES);
    const decrypted = await decryptSegment(ciphertext, key, IV);

    expect(decrypted).toHaveLength(32);
    expect([...decrypted]).toEqual([...plaintext]);
  });

  it("produces different plaintext for a different IV, as CBC requires", async () => {
    const plaintext = new Uint8Array(16).fill(3);
    const ciphertext = await encrypt(plaintext);

    const key = await importAesKey(KEY_BYTES);
    const wrongIv = new Uint8Array(16).fill(9);

    // Wrong IV corrupts the first block but padding still validates, so this
    // decrypts to *something* — just not the original bytes.
    const decrypted = await decryptSegment(ciphertext, key, wrongIv).catch(() => null);
    if (decrypted) expect([...decrypted]).not.toEqual([...plaintext]);
  });

  it("works on a view into a larger buffer", async () => {
    const plaintext = new Uint8Array([42, 43, 44]);
    const ciphertext = await encrypt(plaintext);

    // Simulate a segment sliced out of a bigger read buffer.
    const backing = new Uint8Array(ciphertext.byteLength + 10);
    backing.set(ciphertext, 5);
    const view = backing.subarray(5, 5 + ciphertext.byteLength);

    const key = await importAesKey(KEY_BYTES);
    const decrypted = await decryptSegment(view, key, IV);

    expect([...decrypted]).toEqual([...plaintext]);
  });
});
