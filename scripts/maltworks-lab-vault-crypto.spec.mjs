import test from "node:test";
import assert from "node:assert/strict";
import { seal, unseal } from "./maltworks-lab-vault-crypto.mjs";

const password = "A-Very-Long-Unique-Test-Passphrase-2026";
const sample = {
  account_id: "test-only",
  hostname: "api-staging.maltworks.com.br",
  client_id: "fake-client-id",
  client_secret: "fake-test-secret",
  tokens: { "MW-C00000000000": "test-token" },
};

test("portable Lab bundle has random salt and authenticated encryption", () => {
  const first = seal(password, sample);
  const second = seal(password, sample);
  assert.equal(first.format, "MALTWORKS_LAB_STAGING_PORTABLE_V1");
  assert.equal(first.cipher, "aes-256-gcm");
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.nonce, second.nonce);
  assert.deepEqual(unseal(password, first), sample);
  assert.deepEqual(unseal(password, second), sample);
  const encoded = JSON.stringify(first);
  assert.ok(!encoded.includes("fake-test-secret"));
  assert.ok(!encoded.includes("test-token"));
});

test("incorrect password, modified tag or modified ciphertext never decrypts", () => {
  const sealed = seal(password, sample);
  assert.throws(() => unseal("Wrong-Unique-Passphrase-1234567890", sealed));
  assert.throws(() => unseal(password, { ...sealed, tag: "AAAAAAAAAAAAAAAAAAAAAA==" }));
  const changed = sealed.ciphertext.charAt(0) === "A" ? "B" : "A";
  assert.throws(() => unseal(password, {
    ...sealed, ciphertext: changed + sealed.ciphertext.slice(1),
  }));
  assert.throws(() => unseal(password, { ...sealed, kdf: "none" }));
});

test("8-character transfer passwords work and shorter passwords are rejected", () => {
  const shortPassword = "Ab7#q9X!";
  const envelope = seal(shortPassword, sample);
  assert.deepEqual(unseal(shortPassword, envelope), sample);
  assert.throws(() => unseal("Wrong123", envelope));
  assert.throws(() => seal("Ab7#q9X", sample));
});

test("unsupported passphrases are rejected before encryption", () => {
  assert.throws(() => seal("short", sample));
  assert.throws(() => seal("Password With Spaces 2026", sample));
  assert.throws(() => seal("example-passphrase-com-acento-ação", sample));
  assert.throws(() => seal(password, "raw secret"));
});
