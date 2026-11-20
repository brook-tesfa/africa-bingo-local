'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LicenseService } = require('../license-service');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'africa-license-test-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const deviceA = '11112222333344445555666677778888';
const deviceB = '99990000aaaabbbbccccddddeeeeffff';
const formattedDeviceA = 'SW-1111-2222-3333-4444-5555-6666-7777-8888';

function issueLicense(overrides = {}) {
  const payload = {
    version: 1,
    product: 'homemade-bingo',
    licenseId: `TEST-${crypto.randomBytes(6).toString('hex')}`,
    bingoName: 'Africa Test Bingo',
    deviceCode: formattedDeviceA,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.sign(null, Buffer.from(payloadBase64, 'utf8'), privateKey).toString('base64url');
  return `HB1.${payloadBase64}.${signature}`;
}

try {
  const service = new LicenseService({
    storageRoot: testRoot,
    deviceCodeProvider: () => deviceA,
    publicKey: publicPem
  });
  assert.equal(service.getStatus().reason, 'NOT_ACTIVATED');
  assert.equal(service.getDeviceCodeDisplay(), formattedDeviceA);

  const code = issueLicense();
  const activated = service.activate(code);
  assert.equal(activated.deviceCode, deviceA);
  assert.equal(service.getStatus().valid, true);
  const renewedCode = issueLicense({ bingoName: 'Africa Renewed Bingo' });
  service.activate(renewedCode);
  assert.equal(service.getStatus().license.bingoName, 'Africa Renewed Bingo', 'activation renewal must replace the existing file');
  assert.equal(service.verifyActivationCode(issueLicense({ deviceCode: deviceA })).deviceCode, deviceA, 'older unprefixed licenses must remain compatible');

  fs.renameSync(service.licensePath, service.backupPath);
  assert.equal(service.getStatus().valid, true, 'an interrupted activation must recover its backup');
  assert.equal(fs.existsSync(service.licensePath), true);
  assert.equal(fs.existsSync(service.backupPath), false);

  const restarted = new LicenseService({
    storageRoot: testRoot,
    deviceCodeProvider: () => deviceA,
    publicKey: publicPem
  });
  assert.equal(restarted.getStatus().valid, true, 'activation must survive an app restart');

  const copiedToAnotherDevice = new LicenseService({
    storageRoot: testRoot,
    deviceCodeProvider: () => deviceB,
    publicKey: publicPem
  });
  const copiedStatus = copiedToAnotherDevice.getStatus();
  assert.equal(copiedStatus.valid, false);
  assert.equal(copiedStatus.reason, 'WRONG_DEVICE');

  const tamperedParts = code.split('.');
  const tamperedPayload = JSON.parse(Buffer.from(tamperedParts[1], 'base64url').toString('utf8'));
  tamperedPayload.bingoName = 'Tampered';
  tamperedParts[1] = Buffer.from(JSON.stringify(tamperedPayload), 'utf8').toString('base64url');
  assert.throws(() => service.verifyActivationCode(tamperedParts.join('.')), /signature/i);

  assert.throws(
    () => service.verifyActivationCode(issueLicense({ deviceCode: deviceB })),
    /another computer/i
  );
  assert.throws(
    () => service.verifyActivationCode(issueLicense({ expiresAt: new Date(Date.now() - 1000).toISOString() })),
    /expired/i
  );

  console.log('license service passed (signature, device binding, renewal, recovery, persistence, copy rejection, expiry)');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
