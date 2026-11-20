'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeDeviceCode, formatDeviceCode } = require('./voucher-service');

const LICENSE_PREFIX = 'HB1';
const PRODUCT_ID = 'homemade-bingo';
const MAX_LICENSE_LENGTH = 64 * 1024;

function normalizeLicenseDeviceCode(value) {
  const clean = String(value || '').trim().replace(/^(?:TPM|SW|DEV)-/i, '');
  return normalizeDeviceCode(clean);
}

class LicenseError extends Error {
  constructor(code, message, license = null) {
    super(message);
    this.name = 'LicenseError';
    this.code = code;
    this.license = license;
  }
}

function readBundledPublicKey() {
  return fs.readFileSync(path.join(__dirname, 'license-public.pem'), 'utf8');
}

class LicenseService {
  constructor(options = {}) {
    if (!options.storageRoot) throw new Error('License storage root is required.');
    if (typeof options.deviceCodeProvider !== 'function') {
      throw new Error('License device-code provider is required.');
    }
    this.storageRoot = options.storageRoot;
    this.deviceCodeProvider = options.deviceCodeProvider;
    this.publicKey = options.publicKey || readBundledPublicKey();
    this.licensePath = options.licensePath || path.join(this.storageRoot, 'africa-bingo.license');
    this.backupPath = `${this.licensePath}.bak`;
  }

  recoverInterruptedActivation() {
    if (fs.existsSync(this.licensePath) || !fs.existsSync(this.backupPath)) return;
    fs.mkdirSync(this.storageRoot, { recursive: true });
    fs.renameSync(this.backupPath, this.licensePath);
  }

  getDeviceCode() {
    const code = normalizeLicenseDeviceCode(this.deviceCodeProvider());
    if (!/^[a-f0-9]{32}$/.test(code)) {
      throw new LicenseError('DEVICE_ID_UNAVAILABLE', 'Could not read this computer Device Code.');
    }
    return code;
  }

  getDeviceCodeDisplay() {
    // Africa currently uses the operating-system machine identity rather than
    // a non-exportable TPM key, so the truthful World-license prefix is SW-.
    return `SW-${formatDeviceCode(this.getDeviceCode())}`;
  }

  verifyActivationCode(activationCode) {
    const cleanCode = String(activationCode || '').trim();
    if (!cleanCode || cleanCode.length > MAX_LICENSE_LENGTH) {
      throw new LicenseError('INVALID_ACTIVATION', 'Invalid activation code.');
    }

    const parts = cleanCode.split('.');
    if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) {
      throw new LicenseError('INVALID_ACTIVATION', 'Invalid activation format.');
    }

    const payloadBase64 = parts[1];
    let signature;
    let rawLicense;
    try {
      signature = Buffer.from(parts[2], 'base64url');
      rawLicense = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));
    } catch {
      throw new LicenseError('INVALID_ACTIVATION', 'Invalid activation data.');
    }

    if (!crypto.verify(null, Buffer.from(payloadBase64, 'utf8'), this.publicKey, signature)) {
      throw new LicenseError('INVALID_SIGNATURE', 'Invalid activation signature.');
    }
    if (rawLicense?.product !== PRODUCT_ID) {
      throw new LicenseError('WRONG_PRODUCT', 'This activation belongs to another product.');
    }

    // Accept both current prefixed World-license codes and older plain codes.
    const licensedDevice = normalizeLicenseDeviceCode(rawLicense.deviceCode);
    if (!licensedDevice || licensedDevice !== this.getDeviceCode()) {
      throw new LicenseError('WRONG_DEVICE', 'This activation belongs to another computer.');
    }

    const bingoName = String(rawLicense.bingoName || '').trim();
    const licenseId = String(rawLicense.licenseId || '').trim();
    if (!bingoName || bingoName.length > 40) {
      throw new LicenseError('INVALID_BINGO_NAME', 'Invalid Bingo name.');
    }
    if (!licenseId || licenseId.length > 100) {
      throw new LicenseError('INVALID_LICENSE_ID', 'Invalid license ID.');
    }

    let issuedAt = null;
    if (rawLicense.issuedAt) {
      const issuedMs = Date.parse(rawLicense.issuedAt);
      if (!Number.isFinite(issuedMs) || issuedMs > Date.now() + 86_400_000) {
        throw new LicenseError('INVALID_LICENSE_TIME', 'Invalid activation issue date.');
      }
      issuedAt = new Date(issuedMs).toISOString();
    }

    let expiresAt = null;
    if (rawLicense.expiresAt) {
      const expiresMs = Date.parse(rawLicense.expiresAt);
      if (!Number.isFinite(expiresMs)) {
        throw new LicenseError('INVALID_LICENSE_TIME', 'Invalid activation expiration date.');
      }
      if (expiresMs <= Date.now()) {
        throw new LicenseError('LICENSE_EXPIRED', 'This Africa Bingo activation has expired.');
      }
      expiresAt = new Date(expiresMs).toISOString();
    }

    return {
      version: Number(rawLicense.version) || 1,
      product: PRODUCT_ID,
      licenseId,
      bingoName,
      deviceCode: licensedDevice,
      issuedAt,
      expiresAt,
      licenseType: expiresAt ? 'timed' : 'lifetime'
    };
  }

  activate(activationCode) {
    const license = this.verifyActivationCode(activationCode);
    fs.mkdirSync(this.storageRoot, { recursive: true });
    const temporaryPath = `${this.licensePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;

    try {
      fs.writeFileSync(temporaryPath, String(activationCode).trim(), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });

      fs.rmSync(this.backupPath, { force: true });
      if (fs.existsSync(this.licensePath)) {
        fs.renameSync(this.licensePath, this.backupPath);
      }

      try {
        fs.renameSync(temporaryPath, this.licensePath);
      } catch (error) {
        if (!fs.existsSync(this.licensePath) && fs.existsSync(this.backupPath)) {
          fs.renameSync(this.backupPath, this.licensePath);
        }
        throw error;
      }

      fs.rmSync(this.backupPath, { force: true });
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
    return license;
  }

  getStatus() {
    try {
      this.recoverInterruptedActivation();
    } catch (error) {
      return {
        valid: false,
        activated: true,
        reason: 'LICENSE_STORAGE_ERROR',
        message: `Could not recover the saved activation: ${error.message}`
      };
    }

    if (!fs.existsSync(this.licensePath)) {
      return {
        valid: false,
        activated: false,
        reason: 'NOT_ACTIVATED',
        message: 'Africa Bingo must be activated for this computer.'
      };
    }

    try {
      const code = fs.readFileSync(this.licensePath, 'utf8');
      return { valid: true, activated: true, license: this.verifyActivationCode(code) };
    } catch (error) {
      return {
        valid: false,
        activated: true,
        reason: error.code || 'INVALID_LICENSE',
        message: error.message || 'The activation is invalid.',
        license: error.license || null
      };
    }
  }
}

module.exports = {
  LicenseService,
  LicenseError,
  LICENSE_PREFIX,
  PRODUCT_ID,
  normalizeLicenseDeviceCode
};
