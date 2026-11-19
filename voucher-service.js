'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VOUCHER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2dAxp8R5uWHM5lSREaqllwIHVqdZ9B3YXXgud4deLpE=
-----END PUBLIC KEY-----
`;

function normalizeDeviceCode(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function formatDeviceCode(value) {
  return normalizeDeviceCode(value).toUpperCase().match(/.{1,4}/g)?.join('-') || '';
}

function readOperatingSystemIdentity() {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('reg.exe', [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
        '/v',
        'MachineGuid'
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
      if (match?.[1]) return match[1].trim();
    }

    if (process.platform === 'darwin') {
      const output = execFileSync('/usr/sbin/ioreg', [
        '-rd1',
        '-c',
        'IOPlatformExpertDevice'
      ], { encoding: 'utf8', timeout: 5000 });
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i);
      if (match?.[1]) return match[1].trim();
    }

    for (const candidate of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      if (fs.existsSync(candidate)) {
        const value = fs.readFileSync(candidate, 'utf8').trim();
        if (value) return value;
      }
    }
  } catch {
    // A persistent installation identity is used below when OS identity is unavailable.
  }

  return null;
}

class VoucherService {
  constructor(options = {}) {
    this.storageRoot = options.storageRoot || path.join(os.tmpdir(), 'africa-bingo-local');
    this.publicKey = options.publicKey || VOUCHER_PUBLIC_KEY;
    this.machineIdentityProvider = options.machineIdentityProvider || readOperatingSystemIdentity;
    this.deviceCode = null;
  }

  getInstallationIdentity() {
    const operatingSystemIdentity = this.machineIdentityProvider?.();
    if (operatingSystemIdentity) return String(operatingSystemIdentity).trim();

    fs.mkdirSync(this.storageRoot, { recursive: true });
    const identityPath = path.join(this.storageRoot, 'device-identity');

    if (!fs.existsSync(identityPath)) {
      try {
        fs.writeFileSync(identityPath, crypto.randomBytes(32).toString('hex'), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx'
        });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }

    return fs.readFileSync(identityPath, 'utf8').trim();
  }

  getDeviceCode() {
    if (!this.deviceCode) {
      this.deviceCode = crypto
        .createHash('sha256')
        .update(`africa-bingo-local:${this.getInstallationIdentity()}`, 'utf8')
        .digest('hex')
        .slice(0, 32);
    }
    return this.deviceCode;
  }

  getDeviceCodeDisplay() {
    return formatDeviceCode(this.getDeviceCode());
  }

  verifyVoucher(voucherCode) {
    const cleanCode = String(voucherCode || '').trim();
    if (!cleanCode || cleanCode.length > 16 * 1024) {
      throw new Error('Invalid voucher code.');
    }
    const parts = cleanCode.split('.');

    if (parts.length !== 3 || !['HBV1', 'ABV1'].includes(parts[0])) {
      throw new Error('Invalid voucher code.');
    }

    let payloadBytes;
    let signature;
    let payload;
    try {
      payloadBytes = Buffer.from(parts[1], 'base64url');
      signature = Buffer.from(parts[2], 'base64url');
      payload = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
      throw new Error('Invalid voucher code.');
    }

    if (!crypto.verify(null, payloadBytes, this.publicKey, signature)) {
      throw new Error('Voucher signature is invalid.');
    }
    if (payload?.v !== 1) throw new Error('Unsupported voucher version.');

    const voucherId = String(payload.voucherId || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(voucherId)) {
      throw new Error('Voucher ID is invalid.');
    }

    const amount = Math.round((Number(payload.amount) + Number.EPSILON) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
      throw new Error('Voucher amount is invalid.');
    }

    const currentDevice = normalizeDeviceCode(this.getDeviceCode());
    if (normalizeDeviceCode(payload.deviceCode) !== currentDevice) {
      throw new Error('This voucher belongs to another computer.');
    }

    let issuedAt = null;
    if (payload.issuedAt) {
      const issuedTime = Date.parse(payload.issuedAt);
      if (!Number.isFinite(issuedTime) || issuedTime > Date.now() + 86_400_000) {
        throw new Error('Voucher issue date is invalid.');
      }
      issuedAt = new Date(issuedTime).toISOString();
    }

    let expiresAt = null;
    if (payload.expiresAt) {
      const expiryTime = Date.parse(payload.expiresAt);
      if (!Number.isFinite(expiryTime)) throw new Error('Voucher expiry date is invalid.');
      if (expiryTime <= Date.now()) throw new Error('This voucher has expired.');
      expiresAt = new Date(expiryTime).toISOString();
    }

    return {
      voucherId,
      amount,
      deviceCode: currentDevice,
      issuedAt,
      expiresAt,
      voucherHash: crypto.createHash('sha256').update(cleanCode, 'utf8').digest('hex')
    };
  }
}

module.exports = {
  VoucherService,
  VOUCHER_PUBLIC_KEY,
  formatDeviceCode,
  normalizeDeviceCode
};
