/**
 * Parse an OpenSSH public key line ("type base64 [comment]") and compute its
 * SHA256 fingerprint exactly like `ssh-keygen -l` (SHA-256 over the wire
 * blob, unpadded base64). Uses WebCrypto; the private key is never parsed here.
 */
const ALG: Record<string, string> = {
  'ssh-ed25519': 'ed25519',
  'ssh-rsa': 'rsa',
  'ecdsa-sha2-nistp256': 'ecdsa-p256',
  'ecdsa-sha2-nistp384': 'ecdsa-p384',
  'ecdsa-sha2-nistp521': 'ecdsa-p521',
  'sk-ssh-ed25519@openssh.com': 'ed25519-sk',
  'sk-ecdsa-sha2-nistp256@openssh.com': 'ecdsa-p256-sk',
};

export async function sshPublicKeyInfo(line: string): Promise<{ algorithm: string; fingerprint: string; comment: string }> {
  const parts = line.trim().split(/\s+/);
  const [type, b64, ...rest] = parts;
  if (!type || !b64 || !ALG[type]) throw new Error('Unsupported or malformed public key');
  let blob: Uint8Array;
  try {
    blob = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new Error('Public key is not valid base64');
  }
  // The blob must start with the same key type string (length-prefixed).
  const len = (blob[0]! << 24) | (blob[1]! << 16) | (blob[2]! << 8) | blob[3]!;
  const embedded = new TextDecoder().decode(blob.slice(4, 4 + len));
  if (embedded !== type) throw new Error('Key type does not match key data');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', blob as unknown as ArrayBuffer));
  const fp = btoa(String.fromCharCode(...digest)).replace(/=+$/, '');
  return { algorithm: ALG[type]!, fingerprint: `SHA256:${fp}`, comment: rest.join(' ') };
}
