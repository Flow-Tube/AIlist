// Ed25519 manifest envelope: { key_id, payload, sig }. The signature covers the
// exact payload bytes; readers verify first and parse second.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

const SIGNATURE_BYTES = 64;
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const toPrivateKey = (key) => (typeof key === 'string' || Buffer.isBuffer(key) ? createPrivateKey(key) : key);
const toPublicKey = (key) => (typeof key === 'string' || Buffer.isBuffer(key) ? createPublicKey(key) : key);

/** Decode standard base64 with padding, or return null when the text is not canonical base64. */
function decodeBase64(text) {
  if (typeof text !== 'string' || !STANDARD_BASE64.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}

/** Sign payload bytes and return the envelope object. */
export function signEnvelope(payloadBytes, privateKey, keyId) {
  const key = toPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be an Ed25519 private key');
  const sig = sign(null, payloadBytes, key);
  return { key_id: keyId, payload: payloadBytes.toString('base64'), sig: sig.toString('base64') };
}

/**
 * Verify an envelope against trusted public keys ({ [keyId]: PEM or KeyObject })
 * and only then parse its payload.
 *
 * Returns { ok: true, keyId, payloadBytes, payload } or { ok: false, error }.
 */
export function openEnvelope(envelope, publicKeys) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, error: 'envelope is not a JSON object' };
  }
  const { key_id: keyId, payload, sig } = envelope;
  if (typeof keyId !== 'string') return { ok: false, error: 'envelope has no key_id' };
  if (!Object.hasOwn(publicKeys, keyId)) return { ok: false, error: `unknown key_id "${keyId}"` };

  const payloadBytes = decodeBase64(payload);
  if (payloadBytes === null) return { ok: false, error: 'payload is not standard base64' };
  const signature = decodeBase64(sig);
  if (signature === null || signature.length !== SIGNATURE_BYTES) {
    return { ok: false, error: `sig is not ${SIGNATURE_BYTES} bytes of standard base64` };
  }

  const key = toPublicKey(publicKeys[keyId]);
  if (key.asymmetricKeyType !== 'ed25519') return { ok: false, error: `key "${keyId}" is not an Ed25519 public key` };
  if (!verify(null, payloadBytes, key, signature)) return { ok: false, error: 'signature does not verify' };

  try {
    return { ok: true, keyId, payloadBytes, payload: JSON.parse(payloadBytes.toString('utf8')) };
  } catch {
    return { ok: false, error: 'payload is not valid JSON' };
  }
}

/**
 * Read an envelope's payload without verifying it. Only for the publisher's own
 * previous tree, which may have been signed by a different (throwaway) key.
 */
export function readEnvelopeUnverified(envelope) {
  const payloadBytes = decodeBase64(envelope?.payload);
  if (payloadBytes === null) throw new Error('manifest payload is not standard base64');
  return JSON.parse(payloadBytes.toString('utf8'));
}

/** A fresh in-memory Ed25519 key pair for tests and dry runs. Never written to disk. */
export function generateThrowawayKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) };
}
