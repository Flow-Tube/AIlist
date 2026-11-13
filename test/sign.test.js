import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { signEnvelope, openEnvelope, readEnvelopeUnverified, generateThrowawayKey } from '../src/sign.js';

const KEY_ID = 'test-key';
const { privateKey, publicKeyPem } = generateThrowawayKey();
const keys = { [KEY_ID]: publicKeyPem };
const payloadBytes = Buffer.from(JSON.stringify({ schema: 1, list: 'aislist', version: 42, note: 'música' }));

/** Flip one bit of one byte in a base64 field and re-encode it. */
function flipByte(base64, index) {
  const bytes = Buffer.from(base64, 'base64');
  bytes[index] ^= 0x01;
  return bytes.toString('base64');
}

test('round trip verifies and returns the payload', () => {
  const envelope = signEnvelope(payloadBytes, privateKey, KEY_ID);
  assert.equal(envelope.key_id, KEY_ID);
  assert.equal(Buffer.from(envelope.sig, 'base64').length, 64);
  const opened = openEnvelope(envelope, keys);
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.payloadBytes, payloadBytes);
  assert.equal(opened.payload.version, 42);
  assert.equal(opened.payload.note, 'música');
});

test('it survives a JSON round trip of the envelope', () => {
  const envelope = JSON.parse(JSON.stringify(signEnvelope(payloadBytes, privateKey, KEY_ID)));
  assert.equal(openEnvelope(envelope, keys).ok, true);
});

test('a PEM private key string works too', () => {
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(openEnvelope(signEnvelope(payloadBytes, pem, KEY_ID), keys).ok, true);
});

test('a one-byte change to the payload fails', () => {
  const envelope = signEnvelope(payloadBytes, privateKey, KEY_ID);
  for (const index of [0, 10, payloadBytes.length - 1]) {
    const opened = openEnvelope({ ...envelope, payload: flipByte(envelope.payload, index) }, keys);
    assert.deepEqual(opened, { ok: false, error: 'signature does not verify' });
  }
});

test('a one-byte change to the signature fails', () => {
  const envelope = signEnvelope(payloadBytes, privateKey, KEY_ID);
  for (const index of [0, 31, 63]) {
    const opened = openEnvelope({ ...envelope, sig: flipByte(envelope.sig, index) }, keys);
    assert.equal(opened.ok, false);
  }
});

test('an unknown key_id fails', () => {
  const envelope = signEnvelope(payloadBytes, privateKey, 'other-key');
  assert.deepEqual(openEnvelope(envelope, keys), { ok: false, error: 'unknown key_id "other-key"' });
  assert.equal(openEnvelope({ ...envelope, key_id: 'constructor' }, keys).ok, false);
});

test('a different key under the same key_id fails', () => {
  const other = generateThrowawayKey();
  const envelope = signEnvelope(payloadBytes, other.privateKey, KEY_ID);
  assert.equal(openEnvelope(envelope, keys).ok, false);
  assert.equal(openEnvelope(envelope, { [KEY_ID]: createPublicKey(other.publicKeyPem) }).ok, true);
});

test('malformed envelopes fail cleanly', () => {
  const envelope = signEnvelope(payloadBytes, privateKey, KEY_ID);
  assert.equal(openEnvelope(null, keys).ok, false);
  assert.equal(openEnvelope([], keys).ok, false);
  assert.equal(openEnvelope({ ...envelope, payload: 'not base64!' }, keys).ok, false);
  assert.equal(openEnvelope({ ...envelope, sig: envelope.sig.replace(/=+$/, '') }, keys).ok, false);
  assert.equal(openEnvelope({ ...envelope, sig: Buffer.alloc(32).toString('base64') }, keys).ok, false);
});

test('a signed non-JSON payload is rejected after verification', () => {
  const envelope = signEnvelope(Buffer.from('not json'), privateKey, KEY_ID);
  assert.deepEqual(openEnvelope(envelope, keys), { ok: false, error: 'payload is not valid JSON' });
});

test('non-Ed25519 signing keys are refused', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey: ecKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.throws(() => signEnvelope(payloadBytes, ecKey, KEY_ID), /Ed25519/);
});

test('readEnvelopeUnverified decodes without a key', () => {
  const envelope = signEnvelope(payloadBytes, privateKey, KEY_ID);
  assert.equal(readEnvelopeUnverified(envelope).version, 42);
  assert.throws(() => readEnvelopeUnverified({}), /base64/);
});
