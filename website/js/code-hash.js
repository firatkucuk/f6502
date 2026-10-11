// Encodes C64Script source into a URL hash ("#code=<base64url of UTF-8>") so a sample on any
// page can open the playground with that code loaded. No storage, no server.

const MAX_ENCODED_LENGTH = 100_000;

export function encodeCode(source) {
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Throws on invalid base64 or invalid UTF-8. */
export function decodeCode(encoded) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function tryNowUrl(source, playgroundUrl) {
  return `${playgroundUrl}#code=${encodeCode(source)}`;
}

/** `hash` is `location.hash`. Returns the decoded source, or null if absent or malformed. */
export function codeFromHash(hash) {
  const match = /^#code=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match || match[1].length > MAX_ENCODED_LENGTH) return null;
  try {
    return decodeCode(match[1]);
  } catch {
    return null;
  }
}
