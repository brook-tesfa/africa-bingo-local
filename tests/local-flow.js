'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'africa-bingo-local-test-'));
const originalLoad = Module._load;
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;

class CallbackDatabase {
  constructor(filename, callback) {
    this.database = new DatabaseSync(filename);
    queueMicrotask(() => callback?.(null));
  }

  serialize(callback) { callback(); }

  run(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    try {
      const result = this.database.prepare(sql).run(...(params || []));
      callback?.call({
        lastID: Number(result.lastInsertRowid || 0),
        changes: Number(result.changes || 0)
      }, null);
    } catch (err) {
      callback?.call({}, err);
      if (!callback) throw err;
    }
    return this;
  }

  get(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    try { callback(null, this.database.prepare(sql).get(...(params || []))); }
    catch (err) { callback(err); }
  }

  all(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    try { callback(null, this.database.prepare(sql).all(...(params || []))); }
    catch (err) { callback(err); }
  }

  close(callback) {
    this.database.close();
    callback?.(null);
  }
}

const ipcHandlers = new Map();
const ipcListeners = new Map();
const appListeners = new Map();
const windows = [];
let remoteRequestGuard = null;
let permissionRequestHandler = null;
let permissionCheckHandler = null;
let networkEmulation = null;

class MockBrowserWindow {
  constructor() {
    this.webContents = {
      on() {},
      once() {},
      send() {},
      executeJavaScript: async () => undefined,
      getURL: () => '',
      setWindowOpenHandler() {}
    };
    windows.push(this);
  }
  once(_event, callback) { callback(); }
  show() {}
  isDestroyed() { return false; }
  async loadFile(filename) { this.loadedFile = filename; }
  static getAllWindows() { return windows; }
  static fromWebContents() { return windows[0] || null; }
}

const electronMock = {
  app: {
    isPackaged: false,
    setPath() {},
    getPath: () => testRoot,
    whenReady: () => Promise.resolve(),
    on(event, listener) {
      const listeners = appListeners.get(event) || [];
      listeners.push(listener);
      appListeners.set(event, listeners);
    },
    quit() {}
  },
  BrowserWindow: MockBrowserWindow,
  ipcMain: {
    handle(channel, handler) { ipcHandlers.set(channel, handler); },
    on(channel, handler) { ipcListeners.set(channel, handler); }
  },
  Menu: { setApplicationMenu() {} },
  clipboard: { writeText() {} },
  shell: { openExternal: async () => {} },
  session: {
    defaultSession: {
      webRequest: {
        onBeforeRequest(_filter, handler) { remoteRequestGuard = handler; }
      },
      enableNetworkEmulation(options) { networkEmulation = options; },
      setPermissionRequestHandler(handler) { permissionRequestHandler = handler; },
      setPermissionCheckHandler(handler) { permissionCheckHandler = handler; }
    }
  }
};

class TestVoucherService {
  getDeviceCodeDisplay() { return 'TEST-DEVICE-CODE'; }
  verifyVoucher(code) {
    if (code !== 'valid-test-voucher') throw new Error('Invalid voucher code.');
    return {
      voucherId: 'test-voucher-0001',
      amount: 250,
      deviceCode: 'testdevicecode',
      issuedAt: '2026-11-18T00:00:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
      voucherHash: 'a'.repeat(64)
    };
  }
}

class TestLicenseService {
  getDeviceCodeDisplay() { return 'SW-TEST-DEVICE-CODE'; }
  getStatus() {
    return {
      valid: true,
      activated: true,
      license: { bingoName: 'Local Test Bingo', deviceCode: 'testdevicecode' }
    };
  }
  activate() { return this.getStatus().license; }
}

Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronMock;
  if (request === 'sqlite3') return { verbose: () => ({ Database: CallbackDatabase }) };
  if (request === './voucher-service' && parent?.filename?.endsWith('main.js')) {
    return { VoucherService: TestVoucherService };
  }
  if (request === './license-service' && parent?.filename?.endsWith('main.js')) {
    return { LicenseService: TestLicenseService };
  }
  return originalLoad.call(this, request, parent, isMain);
};
global.setInterval = () => 1;
global.clearInterval = () => {};

async function main() {
  require('../main.js');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(typeof remoteRequestGuard, 'function');
  let requestDecision = null;
  remoteRequestGuard({}, decision => { requestDecision = decision; });
  assert.deepEqual(requestDecision, { cancel: true });
  assert.deepEqual(networkEmulation, { offline: true });
  assert.throws(
    () => require('node:http').get('http://127.0.0.1/'),
    error => error?.code === 'ERR_AFRICA_BINGO_NETWORK_DISABLED'
  );

  let permissionDecision = null;
  permissionRequestHandler(null, 'camera', value => { permissionDecision = value; });
  assert.equal(permissionDecision, false);
  assert.equal(permissionCheckHandler(), false);

  const accountStatus = await ipcHandlers.get('get-local-account-status')();
  assert.deepEqual(accountStatus, { success: true, has_accounts: false });

  const created = await ipcHandlers.get('create-local-account')(null, {
    username: 'local_admin',
    password: 'local-password',
    shop_name: 'Local Test Shop',
    shop_address: 'Offline'
  });
  assert.equal(created.success, true, created.message);
  assert.equal(created.shop_id, 1, 'a clean release must create a fresh first shop');
  assert.equal(created.logged_in, true, 'account creation should create a remembered local session');
  const createdSession = await ipcHandlers.get('check-session')();
  assert.equal(createdSession.active, true);
  assert.equal(createdSession.session.username, 'local_admin');

  const activationStatus = await ipcHandlers.get('get-device-activation-status')();
  assert.equal(activationStatus.valid, true);
  assert.equal(activationStatus.device_code, 'SW-TEST-DEVICE-CODE');

  const rejected = await ipcHandlers.get('perform-login')(null, 'local_admin', 'wrong-password');
  assert.equal(rejected.success, false);

  const loggedIn = await ipcHandlers.get('perform-login')(null, 'local_admin', 'local-password');
  assert.equal(loggedIn.success, true, loggedIn.message);
  assert.equal(loggedIn.local_only, true);

  assert.equal(ipcHandlers.has('calculate-game-commission'), true, 'game commission calculator is missing');
  const customCommission = {
    v: 1,
    mode: 'interval',
    preset: 'A',
    manualPercent: 20,
    auto: { baseCartelas: 1, basePercent: 20, incrementPercent: 1 },
    interval: {
      rules: [
        { min: 1, max: 5, percent: 10 },
        { min: 6, max: 10, percent: 25 },
        { min: 20, max: null, percent: 40 }
      ],
      fallbackPercent: 7
    }
  };
  const savedCommission = await ipcHandlers.get('update-commission-game')(null, customCommission);
  assert.equal(savedCommission.success, true, savedCommission.message);
  assert.equal(savedCommission.settings.mode, 'interval');
  const storedSettings = await ipcHandlers.get('get-shop-setting')();
  assert.equal(storedSettings.success, true, storedSettings.message);
  assert.equal(storedSettings.settings.commissionGame, 'CUSTOM');
  assert.deepEqual(storedSettings.settings.commissionSettings.interval.rules, customCommission.interval.rules);
  assert.equal((await ipcHandlers.get('calculate-game-commission')(null, 8)).percent, 25);
  assert.equal((await ipcHandlers.get('calculate-game-commission')(null, 15)).percent, 7);

  const rejectedCommission = await ipcHandlers.get('update-commission-game')(null, {
    ...customCommission,
    interval: {
      rules: [
        { min: 1, max: 10, percent: 10 },
        { min: 10, max: 20, percent: 20 }
      ],
      fallbackPercent: 0
    }
  });
  assert.equal(rejectedCommission.success, false);
  assert.match(rejectedCommission.message, /cannot overlap/i);

  assert.equal(ipcHandlers.has('add-local-credit'), false, 'manual credit IPC must not exist');
  assert.deepEqual(await ipcHandlers.get('get-device-code')(), {
    success: true,
    device_code: 'TEST-DEVICE-CODE'
  });

  const beforeCredit = await ipcHandlers.get('get-shop-info')();
  assert.equal(beforeCredit.status, 'success');

  const invalidVoucher = await ipcHandlers.get('redeem-credit-voucher')(null, 'invalid');
  assert.equal(invalidVoucher.success, false);

  const credited = await ipcHandlers.get('redeem-credit-voucher')(null, 'valid-test-voucher');
  assert.equal(credited.success, true, credited.message);
  assert.equal(Number(credited.balance) - Number(beforeCredit.current_balance), 250);

  const replay = await ipcHandlers.get('redeem-credit-voucher')(null, 'valid-test-voucher');
  assert.equal(replay.success, false);
  assert.match(replay.message, /already been used/i);

  const sale = await ipcHandlers.get('register-sales')({ sender: windows[0].webContents }, {
    no_cards: 10,
    price: 10,
    collected: 100,
    commission: 25
  });
  assert.equal(sale.status, 'success');

  const afterSale = await ipcHandlers.get('get-shop-info')();
  assert.equal(Number(credited.balance) - Number(afterSale.current_balance), 25);

  const loggedOut = await ipcHandlers.get('perform-logout')();
  assert.equal(loggedOut.success, true);
  assert.equal((await ipcHandlers.get('check-session')()).active, false);

  for (const listener of appListeners.get('window-all-closed') || []) {
    await listener();
  }

  console.log('local flow passed (account, login, custom commission, signed voucher, replay block, sale, logout, network deny)');
}

main().finally(() => {
  Module._load = originalLoad;
  global.setInterval = originalSetInterval;
  global.clearInterval = originalClearInterval;
  fs.rmSync(testRoot, { recursive: true, force: true });
}).catch(err => {
  console.error(err);
  process.exitCode = 1;
});
