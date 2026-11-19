'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VoucherService } = require('../voucher-service');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'africa-bingo-voucher-test-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

function signVoucher(service, overrides = {}) {
  const payload = {
    v: 1,
    voucherId: `voucher-${crypto.randomBytes(8).toString('hex')}`,
    deviceCode: service.getDeviceCode(),
    amount: 125.5,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign(null, payloadBytes, privateKey);
  return `ABV1.${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`;
}

try {
  const service = new VoucherService({
    storageRoot: testRoot,
    publicKey,
    machineIdentityProvider: () => 'test-machine-one'
  });

  const valid = service.verifyVoucher(signVoucher(service));
  assert.equal(valid.amount, 125.5);
  assert.equal(valid.deviceCode, service.getDeviceCode());
  assert.match(service.getDeviceCodeDisplay(), /^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);

  const otherDevice = new VoucherService({
    storageRoot: testRoot,
    publicKey,
    machineIdentityProvider: () => 'test-machine-two'
  });
  assert.throws(
    () => otherDevice.verifyVoucher(signVoucher(service)),
    /another computer/i
  );

  assert.throws(
    () => service.verifyVoucher(signVoucher(service, {
      expiresAt: new Date(Date.now() - 1000).toISOString()
    })),
    /expired/i
  );

  const tampered = signVoucher(service).replace('.ey', '.ez');
  assert.throws(() => service.verifyVoucher(tampered), /invalid/i);
  assert.throws(() => service.verifyVoucher('A'.repeat(16 * 1024 + 1)), /invalid/i);

  console.log('voucher service passed (signature, device binding, expiry, tamper rejection)');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
