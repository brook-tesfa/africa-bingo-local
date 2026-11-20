const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell } = require('electron');
const path = require('path');
const { fileURLToPath } = require('node:url');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const NETWORK_DISABLED_CODE = 'ERR_AFRICA_BINGO_NETWORK_DISABLED';
const userDataRoot = app.getPath('userData');
const legacyPortableRoot = path.join(path.dirname(process.execPath), 'africa-bingo-local-data');
const startupLogPath = path.join(userDataRoot, 'logs', 'startup.log');
const startupSmokeTest = process.argv.includes('--smoke-test');
const MAX_STARTUP_LOG_BYTES = 1024 * 1024;

function errorDetails(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error || 'Unknown error');
}

function writeStartupLog(level, message) {
  try {
    fs.mkdirSync(path.dirname(startupLogPath), { recursive: true });
    if (fs.existsSync(startupLogPath) && fs.statSync(startupLogPath).size > MAX_STARTUP_LOG_BYTES) {
      fs.rmSync(`${startupLogPath}.previous`, { force: true });
      fs.renameSync(startupLogPath, `${startupLogPath}.previous`);
    }
    fs.appendFileSync(
      startupLogPath,
      `[${new Date().toISOString()}] ${level}: ${message}\n`,
      'utf8'
    );
  } catch {
    // A native error dialog is still attempted if the diagnostic log cannot be written.
  }
}

function reportStartupFailure(context, error) {
  const details = errorDetails(error);
  writeStartupLog('FATAL', `${context}\n${details}`);
  console.error(context, details);
  process.exitCode = 1;
  if (startupSmokeTest) return;
  try {
    dialog.showErrorBox(
      'Africa Bingo Local could not start',
      `${context}\n\n${error?.message || String(error)}\n\nDiagnostic log:\n${startupLogPath}`
    );
  } catch {
    // The log remains available if Electron cannot display a native dialog.
  }
}

function migrateLegacyPortableData() {
  if (!app.isPackaged) return;
  if (path.resolve(legacyPortableRoot) === path.resolve(userDataRoot)) return;
  if (!fs.existsSync(legacyPortableRoot)) return;

  fs.mkdirSync(userDataRoot, { recursive: true });
  const migrated = [];
  for (const entry of ['database', 'africa-bingo.license', 'device-identity']) {
    const source = path.join(legacyPortableRoot, entry);
    const destination = path.join(userDataRoot, entry);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    const temporary = `${destination}.migration-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.cpSync(source, temporary, {
        recursive: true,
        force: false,
        errorOnExist: true
      });
      fs.renameSync(temporary, destination);
      migrated.push(entry);
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      writeStartupLog('ERROR', `Could not migrate legacy ${entry}: ${errorDetails(error)}`);
    }
  }

  if (migrated.length) {
    writeStartupLog('INFO', `Migrated legacy local data: ${migrated.join(', ')}`);
  }
}

writeStartupLog(
  'INFO',
  `Starting Africa Bingo Local (packaged=${app.isPackaged}, userData=${userDataRoot})`
);

const hasSingleInstanceLock = app.requestSingleInstanceLock?.() ?? true;
if (!hasSingleInstanceLock) {
  writeStartupLog('INFO', 'A second application instance was closed.');
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized?.()) window.restore();
    window.show();
    window.focus();
  });
}

function networkDisabledError() {
  const error = new Error('Africa Bingo Local does not permit network access.');
  error.code = NETWORK_DISABLED_CODE;
  return error;
}

function denyNodeNetwork() {
  throw networkDisabledError();
}

// Deny main-process networking before any non-core dependency is loaded.
// Chromium requests are independently denied in configureOfflineNetworkGuard().
function disableNodeNetworking() {
  const http = require('node:http');
  const https = require('node:https');
  const http2 = require('node:http2');
  const net = require('node:net');
  const tls = require('node:tls');
  const dns = require('node:dns');
  const dgram = require('node:dgram');

  http.request = denyNodeNetwork;
  http.get = denyNodeNetwork;
  https.request = denyNodeNetwork;
  https.get = denyNodeNetwork;
  http2.connect = denyNodeNetwork;
  net.connect = denyNodeNetwork;
  net.createConnection = denyNodeNetwork;
  net.Socket.prototype.connect = denyNodeNetwork;
  tls.connect = denyNodeNetwork;
  dgram.createSocket = denyNodeNetwork;

  for (const method of [
    'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
    'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
    'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'
  ]) {
    if (typeof dns[method] === 'function') dns[method] = denyNodeNetwork;
    if (dns.promises && typeof dns.promises[method] === 'function') {
      dns.promises[method] = denyNodeNetwork;
    }
  }

  globalThis.fetch = denyNodeNetwork;
  if ('WebSocket' in globalThis) {
    globalThis.WebSocket = class DisabledWebSocket {
      constructor() { throw networkDisabledError(); }
    };
  }
}

disableNodeNetworking();
let sqlite3 = null;
let sqliteLoadError = null;
try {
  sqlite3 = require('sqlite3').verbose();
} catch (error) {
  sqliteLoadError = error;
  writeStartupLog('FATAL', `Could not load SQLite.\n${errorDetails(error)}`);
}
const MobileRoom = require('./mobile-room');
const LocalPrivateNetwork = require('./local-private-network');
const { VoucherService } = require('./voucher-service');
const { LicenseService } = require('./license-service');
const {
  parseCommissionSettings,
  validateCommissionSettings,
  calculateCommissionPercent,
  serializeCommissionSettings
} = require('./commission-settings');

for (const flag of [
  'disable-background-networking',
  'disable-component-update',
  'disable-domain-reliability',
  'disable-client-side-phishing-detection',
  'disable-sync',
  'no-pings'
]) {
  app.commandLine?.appendSwitch(flag);
}
app.commandLine?.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');

// Mutable state uses Electron's per-user AppData directory. Unlike an NSIS
// installation directory, this path exists for the current user and is writable
// without administrator permissions. It remains entirely local to the computer.
const voucherService = new VoucherService({ storageRoot: userDataRoot });
const licenseService = new LicenseService({
  storageRoot: userDataRoot,
  deviceCodeProvider: () => voucherService.getDeviceCode()
});
const mobileRoom = new MobileRoom({ assetsDir: path.join(__dirname, 'mobile') });
const localPrivateNetwork = new LocalPrivateNetwork();

let latestMobileRoomDesktopState = {
  totalCards: 150,
  selectedCards: [],
  cartelaType: 'africa',
  cartelaLabel: 'Africa Bingo Cartela'
};

let db;
let databaseClosePromise = null;
let shutdownPromise = null;
let allowImmediateQuit = false;

// ⭐ Balance reconciler interval handle
let reconcileIntervalId = null;
const RECONCILE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// ⭐ Sales counter integrity checker interval handle
let salesCheckIntervalId = null;
const SALES_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================
// ENCRYPTION KEYS (per table, AES-256, base64)
// ============================================================
const ENC_KEYS = {
  shops:         'hFdvKcvyi3NocnnklpdHCHv9sOUZe1/++TV7G4U+hSw=',
  sales:         'c0rvFMf/fehKAbJ9nGzSvB9sSW2EO+IPc7Yh8tSLLCo=',
  deposits:      'lKk7ws61HG0ebB4cTa9KC1MiSwsv6uaR+8eqwdqnufc=',
  session:       'q1H3riBSeo/i4jw5i9rsq4+XugWr2PEhargmIF4p8vM=',
  shop_settings: 'ZEcmDCRovIlGYyR8Wx+n6Y49KB0QN9F9rxQSlBp7RG0=',
  sync_log:      'vqA0ICoihss9A2OGEmYBUtOUnlN7q5OrShC+tqHIQNc=',
  shop_message:  'ibpa8e4yRkD6dSr1zr0mQ4EoR5sGvxRVBYpoyjM3HHw=',
  credentials:   'yrsAa/9So52QoPUN2qY0Bb/+qEiDw+0uEccc+YxbelE='
};

// ============================================================
// ENCRYPT / DECRYPT HELPERS (AES-256-GCM)
// ============================================================
function encryptValue(tableKey, plaintext) {
    if (plaintext === null || plaintext === undefined) return null;
    try {
        const key = Buffer.from(ENC_KEYS[tableKey], 'base64');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const str = String(plaintext);
        const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        const combined = Buffer.concat([iv, authTag, encrypted]);
        return combined.toString('base64');
    } catch (err) {
        console.error(`encryptValue error (${tableKey}):`, err.message);
        return null;
    }
}

function decryptValue(tableKey, ciphertext) {
    if (ciphertext === null || ciphertext === undefined) return null;
    if (typeof ciphertext !== 'string') return ciphertext;
    try {
        const key = Buffer.from(ENC_KEYS[tableKey], 'base64');
        const combined = Buffer.from(ciphertext, 'base64');
        if (combined.length < 29) return ciphertext;
        const iv = combined.slice(0, 12);
        const authTag = combined.slice(12, 28);
        const encrypted = combined.slice(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString('utf8');
    } catch (err) {
        return ciphertext;
    }
}

function decStr(tableKey, val) { return decryptValue(tableKey, val); }
function decNum(tableKey, val) {
    const s = decryptValue(tableKey, val);
    if (s === null || s === undefined || s === '') return 0;
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}
function decInt(tableKey, val) {
    const s = decryptValue(tableKey, val);
    if (s === null || s === undefined || s === '') return 0;
    const n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
}

// ============================================================
// TABLE NAME CONSTANTS (obfuscated)
// ============================================================
const T = {
    shops:         'TP',
    sales:         'XY',
    deposits:      'ZW',
    session:       'QQ',
    shop_settings: 'MM',
    sync_log:      'NN',
    shop_message:  'VV',
    credentials:   'CC',
    local_accounts:'LA',
    voucher_redemptions:'VR'
};

// ============================================================
// COLUMN NAME MAPS (real → obfuscated)
// ============================================================
const C = {
    shops: {
        shop_id: 'a1', shop_name: 'a2', shop_address: 'a3', shop_phone: 'a4',
        current_balance: 'a5', sales_record_count: 'a6', commission: 'a7',
        percentage: 'a8', checkRows: 'a9', checkColumns: 'b1', checkDiagonals: 'b2',
        checkCorners: 'b3', checkMiddle: 'b4', checkCross: 'b5', min_values: 'b6',
        max_values: 'b7', percentages: 'b8', game_time_gap: 'b9', voices: 'c1',
        start_price: 'c2', rules: 'c3', phone_show: 'c4', agent_id: 'c5'
    },
    sales: {
        sales_id: 'd1', shop_id: 'd2', user_id: 'd3', no_cards: 'd4', on_call: 'd5',
        total_called: 'd6', price: 'd7', collected: 'd8', commission: 'd9',
        balance_after_sales: 'e1', started_time: 'e2', ended_time: 'e3', synced: 'e4'
    },
    deposits: {
        deposit_id: 'f1', shop_id: 'f2', deposit_amount: 'f3',
        balance_before_deposit: 'f4', balance_after_deposit: 'f5', date_of_deposit: 'f6'
    },
    session: {
        user_id: 'g1', username: 'g2', shop_id: 'g3', user_type: 'g4', active: 'g5'
    },
    shop_settings: {
        shop_id: 'h1', game_time_gap: 'h2', voices_game: 'h3', commission_game: 'h4'
    },
    sync_log: {
        sync_key: 'i1', last_deposit_date: 'i2'
    },
    shop_message: {
        id: 'j1', shop_id: 'j2', message: 'j3', updated_at: 'j4', seen: 'j5'
    },
    credentials: {
        username: 'k1', password: 'k2', last_login: 'k3'
    },
    local_accounts: {
        user_id: 'l1', username: 'l2', password_hash: 'l3', password_salt: 'l4',
        shop_id: 'l5', created_at: 'l6'
    },
    voucher_redemptions: {
        voucher_id: 'm1', shop_id: 'm2', device_code: 'm3', amount: 'm4',
        balance_before: 'm5', balance_after: 'm6', voucher_hash: 'm7',
        issued_at: 'm8', expires_at: 'm9', redeemed_at: 'n1'
    }
};

// ============================================================
// PAGE PATH CONSTANTS
// ============================================================
const GAME_PAGE = path.join(__dirname, 'renderer', 'shop', 'game', 'game.html');
const NO_BALANCE_PAGE = path.join(__dirname, 'renderer', 'shop', 'game', 'no-balance.html');
const DASHBOARD_PAGE = path.join(__dirname, 'renderer', 'shop', 'dashboard', 'control.html');
const LOCKED_PAGE = path.join(__dirname, 'renderer', 'locked.html');
const ACTIVATION_PAGE = path.join(__dirname, 'renderer', 'activation.html');

// ============================================================
// CREATE TABLES (with obfuscated names and columns)
// ============================================================
function createTables(database) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const runSchema = sql => database.run(sql, error => {
      if (error) fail(error);
    });

    database.configure?.('busyTimeout', 5000);
    database.serialize(() => {
    runSchema('PRAGMA foreign_keys = ON;');
    runSchema('PRAGMA busy_timeout = 5000;');
    runSchema('PRAGMA journal_mode = WAL;');

    runSchema(`CREATE TABLE IF NOT EXISTS ${T.session} (
      ${C.session.user_id} INTEGER,
      ${C.session.username} TEXT,
      ${C.session.shop_id} INTEGER,
      ${C.session.user_type} TEXT,
      ${C.session.active} INTEGER DEFAULT 1
    );`);

    runSchema(`CREATE TABLE IF NOT EXISTS ${T.sales} (
      ${C.sales.sales_id} INTEGER PRIMARY KEY AUTOINCREMENT,
      ${C.sales.shop_id} INTEGER,
      ${C.sales.user_id} INTEGER,
      ${C.sales.no_cards} TEXT,
      ${C.sales.on_call} TEXT,
      ${C.sales.total_called} TEXT,
      ${C.sales.price} TEXT,
      ${C.sales.collected} TEXT,
      ${C.sales.commission} TEXT,
      ${C.sales.balance_after_sales} TEXT,
      ${C.sales.started_time} TEXT,
      ${C.sales.ended_time} TEXT,
      ${C.sales.synced} INTEGER DEFAULT 0
    );`);

    runSchema(`CREATE TABLE IF NOT EXISTS ${T.shop_message} (
      ${C.shop_message.id} INTEGER PRIMARY KEY AUTOINCREMENT,
      ${C.shop_message.shop_id} INTEGER NOT NULL,
      ${C.shop_message.message} TEXT,
      ${C.shop_message.updated_at} TEXT DEFAULT (datetime('now')),
      ${C.shop_message.seen} INTEGER DEFAULT 0
    );`);

    runSchema(`CREATE TABLE IF NOT EXISTS ${T.shops} (
      ${C.shops.shop_id} INTEGER PRIMARY KEY,
      ${C.shops.shop_name} TEXT NOT NULL UNIQUE,
      ${C.shops.shop_address} TEXT,
      ${C.shops.shop_phone} TEXT,
      ${C.shops.current_balance} TEXT DEFAULT '0',
      ${C.shops.sales_record_count} TEXT DEFAULT '0',
      ${C.shops.commission} TEXT,
      ${C.shops.percentage} TEXT,
      ${C.shops.checkRows} TEXT,
      ${C.shops.checkColumns} TEXT,
      ${C.shops.checkDiagonals} TEXT,
      ${C.shops.checkCorners} TEXT,
      ${C.shops.checkMiddle} TEXT,
      ${C.shops.checkCross} TEXT,
      ${C.shops.min_values} TEXT,
      ${C.shops.max_values} TEXT,
      ${C.shops.percentages} TEXT,
      ${C.shops.game_time_gap} TEXT,
      ${C.shops.voices} TEXT,
      ${C.shops.start_price} TEXT,
      ${C.shops.rules} TEXT,
      ${C.shops.phone_show} TEXT,
      ${C.shops.agent_id} INTEGER
    );`);

    runSchema(`CREATE TABLE IF NOT EXISTS ${T.deposits} (
      ${C.deposits.deposit_id} INTEGER PRIMARY KEY,
      ${C.deposits.shop_id} INTEGER NOT NULL,
      ${C.deposits.deposit_amount} TEXT NOT NULL,
      ${C.deposits.balance_before_deposit} TEXT NOT NULL,
      ${C.deposits.balance_after_deposit} TEXT NOT NULL,
      ${C.deposits.date_of_deposit} TEXT NOT NULL
    );`);

    runSchema(`CREATE TABLE IF NOT EXISTS ${T.credentials} (
      ${C.credentials.username} TEXT PRIMARY KEY,
      ${C.credentials.password} TEXT,
      ${C.credentials.last_login} TEXT
    );`);

    runSchema(`CREATE TABLE IF NOT EXISTS ${T.local_accounts} (
      ${C.local_accounts.user_id} INTEGER PRIMARY KEY AUTOINCREMENT,
      ${C.local_accounts.username} TEXT NOT NULL UNIQUE COLLATE NOCASE,
      ${C.local_accounts.password_hash} TEXT NOT NULL,
      ${C.local_accounts.password_salt} TEXT NOT NULL,
      ${C.local_accounts.shop_id} INTEGER NOT NULL UNIQUE,
      ${C.local_accounts.created_at} TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    runSchema(`CREATE TABLE IF NOT EXISTS ${T.voucher_redemptions} (
      ${C.voucher_redemptions.voucher_id} TEXT PRIMARY KEY,
      ${C.voucher_redemptions.shop_id} INTEGER NOT NULL,
      ${C.voucher_redemptions.device_code} TEXT NOT NULL,
      ${C.voucher_redemptions.amount} TEXT NOT NULL,
      ${C.voucher_redemptions.balance_before} TEXT NOT NULL,
      ${C.voucher_redemptions.balance_after} TEXT NOT NULL,
      ${C.voucher_redemptions.voucher_hash} TEXT NOT NULL UNIQUE,
      ${C.voucher_redemptions.issued_at} TEXT,
      ${C.voucher_redemptions.expires_at} TEXT,
      ${C.voucher_redemptions.redeemed_at} TEXT NOT NULL
    );`);

    runSchema(`CREATE TABLE IF NOT EXISTS ${T.shop_settings} (
      ${C.shop_settings.shop_id} INTEGER PRIMARY KEY,
      ${C.shop_settings.game_time_gap} TEXT DEFAULT '5000',
      ${C.shop_settings.voices_game} TEXT DEFAULT 'A',
      ${C.shop_settings.commission_game} TEXT DEFAULT 'A'
    );`);

    runSchema(`CREATE TABLE IF NOT EXISTS ${T.sync_log} (
      ${C.sync_log.sync_key} TEXT PRIMARY KEY,
      ${C.sync_log.last_deposit_date} TEXT DEFAULT '1970-01-01 00:00:00'
    );`);

    // Retained only for compatibility with databases created by earlier releases.
    runSchema(`CREATE TABLE IF NOT EXISTS ZX (
      z1 TEXT PRIMARY KEY,
      z2 TEXT
    );`);

    database.get('PRAGMA quick_check;', (error, row) => {
      if (error) {
        fail(error);
        return;
      }
      const result = row?.quick_check || Object.values(row || {})[0];
      if (String(result).toLowerCase() !== 'ok') {
        fail(new Error(`SQLite integrity check failed: ${result || 'unknown result'}`));
        return;
      }
      if (settled) return;
      settled = true;
      console.log('✅ All required tables and SQLite integrity verified.');
      resolve();
    });
    });
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve({ salt, hash: derivedKey.toString('hex') });
    });
  });
}

async function verifyPassword(password, salt, expectedHash) {
  const { hash } = await hashPassword(password, salt);
  const actual = Buffer.from(hash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function nowSql() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isIsoCalendarDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

const securedWebContents = new WeakSet();
let offlineNetworkGuardConfigured = false;

function secureWebContents(contents) {
  if (!contents || securedWebContents.has(contents)) return;
  securedWebContents.add(contents);

  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-navigate', (event, url) => {
    try {
      if (!url.toLowerCase().startsWith('file://')) throw new Error('non-file navigation');
      const localPath = path.resolve(fileURLToPath(url));
      const rendererRoot = path.resolve(__dirname, 'renderer');
      if (localPath !== rendererRoot && !localPath.startsWith(`${rendererRoot}${path.sep}`)) {
        throw new Error('file outside renderer directory');
      }
      if (!licenseService.getStatus().valid && path.basename(localPath) !== 'activation.html') {
        console.warn('Blocked navigation before device activation.');
        event.preventDefault();
        return;
      }
      if (path.basename(localPath) === 'game.html') {
        console.warn('Blocked renderer-initiated navigation to the game page.');
        event.preventDefault();
      }
    } catch (_error) {
      console.warn('Blocked non-local navigation.');
      event.preventDefault();
    }
  });
}

function configureOfflineNetworkGuard() {
  if (offlineNetworkGuardConfigured) return;
  offlineNetworkGuardConfigured = true;

  const blockedSchemes = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'];
  session.defaultSession.webRequest.onBeforeRequest({ urls: blockedSchemes }, (_details, callback) => {
    callback({ cancel: true });
  });
  session.defaultSession.enableNetworkEmulation?.({ offline: true });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_event, contents) => secureWebContents(contents));
  console.log('Local-only network guard active: all remote requests are blocked.');
}

// ============================================================
// BALANCE RECONCILER (updated for encryption)
// ============================================================
async function reconcileBalance(shopId) {
    try {
        if (!shopId) {
            console.log('🔄 Reconcile: no shopId provided — skipping.');
            return { success: false, message: 'No shopId provided' };
        }

        return await withImmediateTransaction(async () => {
        const depositsRows = await allAsync(
            `SELECT ${C.deposits.deposit_amount} AS amt FROM ${T.deposits} WHERE ${C.deposits.shop_id} = ?`,
            [shopId]
        );
        let totalDeposits = 0;
        for (const r of depositsRows) {
            totalDeposits += decNum('deposits', r.amt);
        }

        const salesRows = await allAsync(
            `SELECT ${C.sales.commission} AS comm FROM ${T.sales} WHERE ${C.sales.shop_id} = ?`,
            [shopId]
        );
        let totalCommissions = 0;
        for (const r of salesRows) {
            totalCommissions += decNum('sales', r.comm);
        }

        const correctBalance = totalDeposits - totalCommissions;

        const shopRow = await getAsync(
            `SELECT ${C.shops.current_balance} AS bal FROM ${T.shops} WHERE ${C.shops.shop_id} = ?`,
            [shopId]
        );

        if (!shopRow) {
            console.log(`🔄 Reconcile: shop ${shopId} not found in local DB — skipping.`);
            return { success: false, message: 'Shop not found' };
        }

        const storedBalance = decNum('shops', shopRow.bal);

        if (Math.abs(correctBalance - storedBalance) > 0.01) {
            const encryptedBalance = encryptValue('shops', correctBalance.toFixed(2));
            await runAsync(
                `UPDATE ${T.shops} SET ${C.shops.current_balance} = ? WHERE ${C.shops.shop_id} = ?`,
                [encryptedBalance, shopId]
            );
            console.log(`🔄 Balance reconciled for shop ${shopId}: ${storedBalance.toFixed(2)} → ${correctBalance.toFixed(2)} (deposits: ${totalDeposits.toFixed(2)}, commissions: ${totalCommissions.toFixed(2)})`);
            return {
                success: true,
                changed: true,
                oldBalance: storedBalance,
                newBalance: correctBalance,
                totalDeposits,
                totalCommissions
            };
        } else {
            console.log(`✅ Balance OK for shop ${shopId}: ${storedBalance.toFixed(2)} (deposits: ${totalDeposits.toFixed(2)}, commissions: ${totalCommissions.toFixed(2)})`);
            return {
                success: true,
                changed: false,
                balance: storedBalance,
                totalDeposits,
                totalCommissions
            };
        }
        });
    } catch (err) {
        console.error("🔄 Balance reconcile error:", err);
        return { success: false, message: err.message };
    }
}

function startBalanceReconciler() {
    if (reconcileIntervalId) clearInterval(reconcileIntervalId);
    reconcileIntervalId = setInterval(async () => {
        try {
            const session = await getAsync(
                `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
            );
            if (!session || !session.shop_id) return;
            await reconcileBalance(session.shop_id);
        } catch (err) {
            console.error("🔄 Reconcile interval error:", err);
        }
    }, RECONCILE_INTERVAL_MS);
    console.log(`🔄 Balance reconciler started — runs every ${RECONCILE_INTERVAL_MS / 1000} seconds.`);
}

function stopBalanceReconciler() {
    if (reconcileIntervalId) {
        clearInterval(reconcileIntervalId);
        reconcileIntervalId = null;
        console.log('🛑 Balance reconciler stopped.');
    }
}

// ============================================================
// SALES COUNTER INTEGRITY CHECKER
// ============================================================
async function checkSalesCounter() {
    try {
        const session = await getAsync(
            `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
        );
        if (!session || !session.shop_id) return;
        const shopId = session.shop_id;

        const shopRow = await getAsync(
            `SELECT ${C.shops.sales_record_count} AS cnt FROM ${T.shops} WHERE ${C.shops.shop_id} = ?`,
            [shopId]
        );
        if (!shopRow) return;

        const expectedCount = decInt('shops', shopRow.cnt);

        const countRow = await getAsync(
            `SELECT COUNT(*) AS actual FROM ${T.sales} WHERE ${C.sales.shop_id} = ?`,
            [shopId]
        );
        const actualCount = countRow ? parseInt(countRow.actual, 10) : 0;

        if (expectedCount === actualCount) {
            console.log(`🛡️ Sales counter OK for shop ${shopId}: ${actualCount}`);
            return;
        }

        console.warn(`🚨 TAMPER DETECTED! Shop ${shopId} — counter says ${expectedCount} but table has ${actualCount} rows.`);

        const wins = BrowserWindow.getAllWindows();
        wins.forEach(w => {
            if (!w.__salesTamperLocked) {
                w.__salesTamperLocked = true;
                w.loadFile(LOCKED_PAGE);
            }
        });
    } catch (err) {
        console.error('🛡️ Sales counter check error:', err);
    }
}

function startSalesChecker() {
    if (salesCheckIntervalId) clearInterval(salesCheckIntervalId);
    salesCheckIntervalId = setInterval(checkSalesCounter, SALES_CHECK_INTERVAL_MS);
    console.log(`🛡️ Sales counter checker started — runs every ${SALES_CHECK_INTERVAL_MS / 1000} seconds.`);
}

function stopSalesChecker() {
    if (salesCheckIntervalId) {
        clearInterval(salesCheckIntervalId);
        salesCheckIntervalId = null;
        console.log('🛡️ Sales counter checker stopped.');
    }
}

// IPC handler so the renderer can trigger reconciliation on demand
ipcMain.handle('reconcile-balance', async () => {
    try {
        const session = await getAsync(
            `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
        );
        if (!session || !session.shop_id) {
            return { success: false, message: "No active session" };
        }
        return await reconcileBalance(session.shop_id);
    } catch (err) {
        console.error("reconcile-balance IPC error:", err);
        return { success: false, message: err.message };
    }
});

// --- IPC HANDLERS ---

ipcMain.handle('get-local-account-status', async () => {
  try {
    const row = await getAsync(`SELECT COUNT(*) AS count FROM ${T.local_accounts}`);
    return { success: true, has_accounts: Number(row?.count || 0) > 0 };
  } catch (err) {
    return { success: false, has_accounts: false, message: err.message };
  }
});

ipcMain.handle('create-local-account', async (_event, input = {}) => {
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  const shopName = String(input.shop_name || '').trim();
  const shopAddress = String(input.shop_address || 'Local').trim() || 'Local';
  const initialCredit = 0;

  if (!/^[\p{L}\p{N}_.-]{3,50}$/u.test(username)) {
    return { success: false, message: 'Username must be 3-50 letters, numbers, dots, dashes, or underscores.' };
  }
  if (password.length < 6 || password.length > 256) {
    return { success: false, message: 'Password must be between 6 and 256 characters.' };
  }
  if (!shopName || shopName.length > 80) {
    return { success: false, message: 'Shop name is required and must be at most 80 characters.' };
  }
  if (shopAddress.length > 200) {
    return { success: false, message: 'Shop address must be at most 200 characters.' };
  }
  try {
    const duplicate = await getAsync(
      `SELECT ${C.local_accounts.user_id} AS user_id FROM ${T.local_accounts} WHERE ${C.local_accounts.username} = ? COLLATE NOCASE`,
      [username]
    );
    if (duplicate) return { success: false, message: 'That username already exists.' };

    const { salt, hash } = await hashPassword(password);
    return await withImmediateTransaction(async () => {
    const duplicateInTransaction = await getAsync(
      `SELECT ${C.local_accounts.user_id} AS user_id FROM ${T.local_accounts} WHERE ${C.local_accounts.username} = ? COLLATE NOCASE`,
      [username]
    );
    if (duplicateInTransaction) throw new Error('That username already exists.');

    const accountCount = await getAsync(`SELECT COUNT(*) AS count FROM ${T.local_accounts}`);
    const legacyShop = Number(accountCount?.count || 0) === 0
      ? await getAsync(`
          SELECT ${C.shops.shop_id} AS shop_id, ${C.shops.current_balance} AS balance
          FROM ${T.shops}
          ORDER BY ${C.shops.shop_id} ASC LIMIT 1
        `)
      : null;
    const nextShop = await getAsync(`SELECT COALESCE(MAX(${C.shops.shop_id}), 0) + 1 AS next_id FROM ${T.shops}`);
    const shopId = Number(legacyShop?.shop_id || nextShop?.next_id || 1);
    const balanceBeforeCredit = legacyShop ? decNum('shops', legacyShop.balance) : 0;
    const balanceAfterCredit = balanceBeforeCredit + initialCredit;
    const shopValues = [
      shopId,
      encryptValue('shops', shopName),
      encryptValue('shops', shopAddress),
      encryptValue('shops', ''),
      encryptValue('shops', balanceAfterCredit.toFixed(2)),
      encryptValue('shops', '0'),
      encryptValue('shops', 'off'),
      encryptValue('shops', '10'),
      encryptValue('shops', 'checked'),
      encryptValue('shops', 'checked'),
      encryptValue('shops', 'checked'),
      encryptValue('shops', 'checked'),
      encryptValue('shops', 'checked'),
      encryptValue('shops', 'checked'),
      encryptValue('shops', '1,3,16,41,91'),
      encryptValue('shops', '2,15,40,90,150'),
      encryptValue('shops', '0,10,20,25,30'),
      encryptValue('shops', '5000'),
      encryptValue('shops', 'A'),
      encryptValue('shops', '10'),
      encryptValue('shops', '1'),
      encryptValue('shops', ''),
      null
    ];

    if (legacyShop) {
      await runAsync(`
        UPDATE ${T.shops}
        SET ${C.shops.shop_name} = ?, ${C.shops.shop_address} = ?, ${C.shops.current_balance} = ?
        WHERE ${C.shops.shop_id} = ?
      `, [
        encryptValue('shops', shopName),
        encryptValue('shops', shopAddress),
        encryptValue('shops', balanceAfterCredit.toFixed(2)),
        shopId
      ]);
    } else {
      await runAsync(`
      INSERT INTO ${T.shops} (
        ${C.shops.shop_id}, ${C.shops.shop_name}, ${C.shops.shop_address}, ${C.shops.shop_phone},
        ${C.shops.current_balance}, ${C.shops.sales_record_count}, ${C.shops.commission}, ${C.shops.percentage},
        ${C.shops.checkRows}, ${C.shops.checkColumns}, ${C.shops.checkDiagonals}, ${C.shops.checkCorners},
        ${C.shops.checkMiddle}, ${C.shops.checkCross}, ${C.shops.min_values}, ${C.shops.max_values},
        ${C.shops.percentages}, ${C.shops.game_time_gap}, ${C.shops.voices}, ${C.shops.start_price},
        ${C.shops.rules}, ${C.shops.phone_show}, ${C.shops.agent_id}
      ) VALUES (${new Array(23).fill('?').join(', ')})
      `, shopValues);
    }

    const accountResult = await runAsync(`
      INSERT INTO ${T.local_accounts} (
        ${C.local_accounts.username}, ${C.local_accounts.password_hash},
        ${C.local_accounts.password_salt}, ${C.local_accounts.shop_id}
      ) VALUES (?, ?, ?, ?)
    `, [username, hash, salt, shopId]);

    // Account creation is also the first successful local login. Only the
    // session is remembered; the plaintext password is never stored.
    await runAsync(`UPDATE ${T.session} SET ${C.session.active} = 0`);
    await runAsync(`
      INSERT INTO ${T.session} (
        ${C.session.user_id}, ${C.session.username}, ${C.session.shop_id},
        ${C.session.user_type}, ${C.session.active}
      ) VALUES (?, ?, ?, ?, 1)
    `, [
      accountResult.lastID,
      encryptValue('session', username),
      shopId,
      encryptValue('session', 'shop_user')
    ]);

    await runAsync(`
      INSERT INTO ${T.shop_settings} (
        ${C.shop_settings.shop_id}, ${C.shop_settings.game_time_gap},
        ${C.shop_settings.voices_game}, ${C.shop_settings.commission_game}
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(${C.shop_settings.shop_id}) DO NOTHING
    `, [
      shopId,
      encryptValue('shop_settings', '5000'),
      encryptValue('shop_settings', 'A'),
      encryptValue('shop_settings', 'A')
    ]);

    return {
      success: true,
      user_id: accountResult.lastID,
      shop_id: shopId,
      logged_in: true,
      redirect: 'shop/dashboard/control.html',
      message: 'Local account created and signed in.'
    };
    });
  } catch (err) {
    console.error('create-local-account error:', err);
    return { success: false, message: err.message };
  }
});

// Login handler
ipcMain.handle('perform-login', async (_event, username, password) => {
  try {
    const normalizedUsername = String(username || '').trim();
    const normalizedPassword = String(password || '');
    if (normalizedUsername.length > 50 || normalizedPassword.length > 256) {
      return { success: false, message: 'Incorrect local username or password.' };
    }
    const account = await getAsync(`
      SELECT ${C.local_accounts.user_id} AS user_id,
             ${C.local_accounts.username} AS username,
             ${C.local_accounts.password_hash} AS password_hash,
             ${C.local_accounts.password_salt} AS password_salt,
             ${C.local_accounts.shop_id} AS shop_id
      FROM ${T.local_accounts}
      WHERE ${C.local_accounts.username} = ? COLLATE NOCASE
      LIMIT 1
    `, [normalizedUsername]);

    if (!account || !(await verifyPassword(normalizedPassword, account.password_salt, account.password_hash))) {
      return { success: false, message: 'Incorrect local username or password.' };
    }

    const shop = await getAsync(
      `SELECT ${C.shops.shop_id} AS shop_id FROM ${T.shops} WHERE ${C.shops.shop_id} = ?`,
      [account.shop_id]
    );
    if (!shop) return { success: false, message: 'This local account has no shop record.' };

    await withImmediateTransaction(async () => {
      await runAsync(`UPDATE ${T.session} SET ${C.session.active} = 0`);
      await runAsync(`
        INSERT INTO ${T.session} (
          ${C.session.user_id}, ${C.session.username}, ${C.session.shop_id},
          ${C.session.user_type}, ${C.session.active}
        ) VALUES (?, ?, ?, ?, 1)
      `, [
        account.user_id,
        encryptValue('session', account.username),
        account.shop_id,
        encryptValue('session', 'shop_user')
      ]);
    });
    return { success: true, local_only: true, redirect: 'shop/dashboard/control.html' };
  } catch (err) {
    console.error('Local login error:', err);
    return { success: false, message: err.message };
  }
});

// Check session
ipcMain.handle('check-session', async () => {
  try {
    const row = await getAsync(`SELECT * FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`);
    if (!row) return { active: false, session: null };
    return {
      active: true,
      session: {
        user_id: row[C.session.user_id],
        username: decryptValue('session', row[C.session.username]),
        shop_id: row[C.session.shop_id],
        user_type: decryptValue('session', row[C.session.user_type]),
        active: row[C.session.active]
      }
    };
  } catch (error) {
    return { active: false, error: error.message };
  }
});

// Logout
ipcMain.handle('perform-logout', async () => {
  try {
    await mobileRoom.stop();
    const result = await runAsync(
      `UPDATE ${T.session} SET ${C.session.active} = 0 WHERE ${C.session.active} = 1`
    );
    return { success: true, local_only: true, changed: result.changes, message: 'Local logout successful.' };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// Get shop settings
ipcMain.handle('get-shop-settings', async () => {
  try {
    const row = await getAsync(`
      SELECT * FROM ${T.shops}
      WHERE ${C.shops.shop_id} = (
        SELECT ${C.session.shop_id} FROM ${T.session}
        WHERE ${C.session.active} = 1 LIMIT 1
      )
      LIMIT 1
    `);
    if (!row) return { success: false, message: "No shop data found." };

    const settings = {
        shop_id: row[C.shops.shop_id],
        shop_name: decryptValue('shops', row[C.shops.shop_name]),
        shop_address: decryptValue('shops', row[C.shops.shop_address]),
        shop_phone: decryptValue('shops', row[C.shops.shop_phone]),
        current_balance: decNum('shops', row[C.shops.current_balance]),
        sales_record_count: decInt('shops', row[C.shops.sales_record_count]),
        commission: decryptValue('shops', row[C.shops.commission]),
        percentage: decInt('shops', row[C.shops.percentage]),
        checkRows: decryptValue('shops', row[C.shops.checkRows]),
        checkColumns: decryptValue('shops', row[C.shops.checkColumns]),
        checkDiagonals: decryptValue('shops', row[C.shops.checkDiagonals]),
        checkCorners: decryptValue('shops', row[C.shops.checkCorners]),
        checkMiddle: decryptValue('shops', row[C.shops.checkMiddle]),
        checkCross: decryptValue('shops', row[C.shops.checkCross]),
        min_values: decryptValue('shops', row[C.shops.min_values]),
        max_values: decryptValue('shops', row[C.shops.max_values]),
        percentages: decryptValue('shops', row[C.shops.percentages]),
        game_time_gap: decInt('shops', row[C.shops.game_time_gap]),
        voices: decryptValue('shops', row[C.shops.voices]),
        start_price: decInt('shops', row[C.shops.start_price]),
        rules: decInt('shops', row[C.shops.rules]),
        phone_show: decryptValue('shops', row[C.shops.phone_show]),
        agent_id: row[C.shops.agent_id]
    };
    return { success: true, settings };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// The queue prevents an ordinary query from accidentally running inside a
// different handler's transaction on sqlite3's shared connection.
const transactionContext = new AsyncLocalStorage();
let databaseQueue = Promise.resolve();

function enqueueDatabaseOperation(operation) {
  if (transactionContext.getStore()) return operation();
  const result = databaseQueue.then(operation);
  databaseQueue = result.catch(() => {});
  return result;
}

function runAsync(sql, params = []) {
  return enqueueDatabaseOperation(() => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  }));
}

function getAsync(sql, params = []) {
  return enqueueDatabaseOperation(() => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  }));
}

function allAsync(sql, params = []) {
  return enqueueDatabaseOperation(() => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  }));
}

function withImmediateTransaction(operation) {
  const execute = () => transactionContext.run(true, async () => {
    let transactionActive = false;
    try {
      await runAsync('BEGIN IMMEDIATE TRANSACTION');
      transactionActive = true;
      const result = await operation();
      await runAsync('COMMIT');
      transactionActive = false;
      return result;
    } catch (error) {
      if (transactionActive) {
        await runAsync('ROLLBACK').catch(rollbackError => {
          writeStartupLog('ERROR', `SQLite rollback failed: ${errorDetails(rollbackError)}`);
        });
      }
      throw error;
    }
  });

  const result = databaseQueue.then(execute);
  databaseQueue = result.catch(() => {});
  return result;
}

function sendToAllRenderers(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed?.()) window.webContents.send(channel, payload);
  }
}

function getMobileRoomStatusForRenderer() {
  const status = mobileRoom.getStatus();
  if (status.running) return status;
  return {
    ...status,
    totalCards: latestMobileRoomDesktopState.totalCards,
    selectedCards: [...latestMobileRoomDesktopState.selectedCards],
    cartelaType: latestMobileRoomDesktopState.cartelaType,
    cartelaLabel: latestMobileRoomDesktopState.cartelaLabel
  };
}

function sendMobileRoomStatus() {
  sendToAllRenderers('mobile-room-status', getMobileRoomStatusForRenderer());
}

mobileRoom.on('status-changed', () => {
  const status = mobileRoom.getStatus();
  if (status.running) latestMobileRoomDesktopState.selectedCards = [...status.selectedCards];
  sendMobileRoomStatus();
});

mobileRoom.on('card-changed', change => {
  sendToAllRenderers('mobile-room-card-change', change);
});

ipcMain.handle('get-device-code', () => ({
  success: true,
  device_code: voucherService.getDeviceCodeDisplay()
}));

ipcMain.handle('get-device-activation-status', () => {
  try {
    return {
      success: true,
      device_code: licenseService.getDeviceCodeDisplay(),
      ...licenseService.getStatus()
    };
  } catch (error) {
    return { success: false, valid: false, message: error.message };
  }
});

ipcMain.handle('activate-device-license', (_event, activationCode) => {
  try {
    const license = licenseService.activate(activationCode);
    return { success: true, license };
  } catch (error) {
    return { success: false, reason: error.code || 'ACTIVATION_FAILED', message: error.message };
  }
});

ipcMain.handle('complete-device-activation', async event => {
  const status = licenseService.getStatus();
  if (!status.valid) return { success: false, message: status.message };
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, message: 'Application window is unavailable.' };
  await loadAuthorizedEntry(win);
  return { success: true };
});

ipcMain.handle('redeem-credit-voucher', async (_event, voucherCode) => {
  try {
    const voucher = voucherService.verifyVoucher(voucherCode);
    const active = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!active?.shop_id) return { success: false, message: 'No active local account.' };

    return await withImmediateTransaction(async () => {
    const duplicate = await getAsync(`
      SELECT ${C.voucher_redemptions.voucher_id} AS voucher_id
      FROM ${T.voucher_redemptions}
      WHERE ${C.voucher_redemptions.voucher_id} = ?
         OR ${C.voucher_redemptions.voucher_hash} = ?
      LIMIT 1
    `, [voucher.voucherId, voucher.voucherHash]);
    if (duplicate) throw new Error('This voucher has already been used.');

    const shop = await getAsync(
      `SELECT ${C.shops.current_balance} AS balance FROM ${T.shops} WHERE ${C.shops.shop_id} = ?`,
      [active.shop_id]
    );
    if (!shop) throw new Error('Local shop record not found.');

    const before = decNum('shops', shop.balance);
    const after = Math.round((before + voucher.amount + Number.EPSILON) * 100) / 100;
    const redeemedAt = nowSql();

    await runAsync(
      `UPDATE ${T.shops} SET ${C.shops.current_balance} = ? WHERE ${C.shops.shop_id} = ?`,
      [encryptValue('shops', after.toFixed(2)), active.shop_id]
    );
    await runAsync(`
      INSERT INTO ${T.deposits} (
        ${C.deposits.shop_id}, ${C.deposits.deposit_amount},
        ${C.deposits.balance_before_deposit}, ${C.deposits.balance_after_deposit},
        ${C.deposits.date_of_deposit}
      ) VALUES (?, ?, ?, ?, ?)
    `, [
      active.shop_id,
      encryptValue('deposits', voucher.amount.toFixed(2)),
      encryptValue('deposits', before.toFixed(2)),
      encryptValue('deposits', after.toFixed(2)),
      redeemedAt
    ]);
    await runAsync(`
      INSERT INTO ${T.voucher_redemptions} (
        ${C.voucher_redemptions.voucher_id}, ${C.voucher_redemptions.shop_id},
        ${C.voucher_redemptions.device_code}, ${C.voucher_redemptions.amount},
        ${C.voucher_redemptions.balance_before}, ${C.voucher_redemptions.balance_after},
        ${C.voucher_redemptions.voucher_hash}, ${C.voucher_redemptions.issued_at},
        ${C.voucher_redemptions.expires_at}, ${C.voucher_redemptions.redeemed_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      voucher.voucherId,
      active.shop_id,
      voucher.deviceCode,
      encryptValue('deposits', voucher.amount.toFixed(2)),
      encryptValue('deposits', before.toFixed(2)),
      encryptValue('deposits', after.toFixed(2)),
      voucher.voucherHash,
      voucher.issuedAt,
      voucher.expiresAt,
      redeemedAt
    ]);

    return {
      success: true,
      voucher_id: voucher.voucherId,
      amount: voucher.amount,
      balance: after,
      message: 'Voucher redeemed successfully.'
    };
    });
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('copy-local-text', (_event, value) => {
  clipboard.writeText(String(value || '').slice(0, 4096));
  return { success: true };
});

ipcMain.handle('mobile-room-set-desktop-state', (_event, state = {}) => {
  const totalCards = Number(state.totalCards);
  if (!Number.isInteger(totalCards) || totalCards < 1 || totalCards > 10000) {
    throw new Error('Invalid cartela count.');
  }

  const selectedCards = Array.isArray(state.selectedCards)
    ? state.selectedCards.map(Number).filter(id => Number.isInteger(id) && id >= 1 && id <= totalCards)
    : [];
  const next = {
    totalCards,
    selectedCards,
    cartelaType: String(state.cartelaType || 'africa').slice(0, 120),
    cartelaLabel: String(state.cartelaLabel || 'Africa Bingo Cartela').slice(0, 160)
  };
  const deckChanged = mobileRoom.running && (
    latestMobileRoomDesktopState.totalCards !== next.totalCards ||
    latestMobileRoomDesktopState.cartelaType !== next.cartelaType
  );

  latestMobileRoomDesktopState = next;
  if (deckChanged) mobileRoom.configureDeck(next);
  sendMobileRoomStatus();
  return getMobileRoomStatusForRenderer();
});

ipcMain.handle('mobile-room-get-status', () => getMobileRoomStatusForRenderer());
ipcMain.handle('mobile-room-set-address', (_event, address) => mobileRoom.setPreferredAddress(address));
ipcMain.handle('mobile-room-refresh-address', () => mobileRoom.refreshNetworkAddress());

ipcMain.handle('mobile-room-start', async () => {
  const active = await getAsync(
    `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
  );
  if (!active?.shop_id) throw new Error('Log in before starting the mobile room.');
  const shop = await getAsync(
    `SELECT ${C.shops.shop_name} AS name FROM ${T.shops} WHERE ${C.shops.shop_id} = ?`,
    [active.shop_id]
  );

  return mobileRoom.start({
    mode: 'approval',
    ...latestMobileRoomDesktopState,
    bingoName: decryptValue('shops', shop?.name) || 'Africa Bingo Local'
  });
});

ipcMain.handle('mobile-room-stop', async () => {
  const beforeStop = mobileRoom.getStatus();
  if (beforeStop.running) latestMobileRoomDesktopState.selectedCards = [...beforeStop.selectedCards];
  await mobileRoom.stop();
  return getMobileRoomStatusForRenderer();
});
ipcMain.handle('mobile-room-approve-device', (_event, clientId) => mobileRoom.approveClient(clientId));
ipcMain.handle('mobile-room-deny-device', (_event, clientId) => mobileRoom.denyClient(clientId));
ipcMain.handle('mobile-room-set-card', (_event, cardId, selected) => {
  if (!mobileRoom.running) return getMobileRoomStatusForRenderer();
  return mobileRoom.setDesktopCard(cardId, selected);
});
ipcMain.handle('mobile-room-lock-selection', () => mobileRoom.lockSelection());
ipcMain.handle('mobile-room-new-round', () => {
  latestMobileRoomDesktopState.selectedCards = [];
  const status = mobileRoom.newRound();
  sendMobileRoomStatus();
  return status;
});

ipcMain.handle('private-network-get-status', () => localPrivateNetwork.status());
ipcMain.handle('private-network-start', async () => {
  try {
    const status = await localPrivateNetwork.start();
    mobileRoom.refreshNetworkAddress();
    sendMobileRoomStatus();
    return { success: true, status };
  } catch (error) {
    return {
      success: false,
      code: error.code || 'PRIVATE_NETWORK_START_FAILED',
      error: error.message,
      status: await localPrivateNetwork.status()
    };
  }
});
ipcMain.handle('private-network-stop', async () => {
  try {
    const status = await localPrivateNetwork.stop();
    mobileRoom.refreshNetworkAddress();
    sendMobileRoomStatus();
    return { success: true, status };
  } catch (error) {
    return {
      success: false,
      code: error.code || 'PRIVATE_NETWORK_STOP_FAILED',
      error: error.message,
      status: await localPrivateNetwork.status()
    };
  }
});

ipcMain.handle('private-network-open-settings', async () => {
  if (process.platform !== 'win32') {
    return {
      success: false,
      error: 'Windows Mobile Hotspot settings are only available in the Windows build.'
    };
  }

  try {
    await shell.openExternal('ms-settings:network-mobilehotspot');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('check-balance', async () => {
  try {
    const active = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!active?.shop_id) return { status: 'error', message: 'No active local account.' };
    const shop = await getAsync(
      `SELECT ${C.shops.current_balance} AS balance FROM ${T.shops} WHERE ${C.shops.shop_id} = ?`,
      [active.shop_id]
    );
    if (!shop) return { status: 'error', message: 'Local shop record not found.' };
    return { status: 'success', balance: decNum('shops', shop.balance), local_only: true };
  } catch (error) {
    return { status: 'error', message: error.message || 'Could not read the local balance.' };
  }
});

// Handle register-sales event
ipcMain.handle('register-sales', async (_event, data = {}) => {
  try {
    const noCards = Number(data.no_cards);
    const price = Number(data.price);
    const collected = Number(data.collected);
    const commission = Number(data.commission);

    if (!Number.isInteger(noCards) || noCards < 1 || noCards > 10000) {
      return { status: 'error', message: 'Invalid cartela count.' };
    }
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) {
      return { status: 'error', message: 'Invalid cartela price.' };
    }
    if (!Number.isFinite(collected) || collected <= 0 || collected > 1_000_000_000) {
      return { status: 'error', message: 'Invalid collected amount.' };
    }
    const expectedCollected = Math.round((noCards * price + Number.EPSILON) * 100) / 100;
    if (Math.abs(collected - expectedCollected) > 0.01) {
      return { status: 'error', message: 'Collected amount does not match cartela count and price.' };
    }
    if (!Number.isFinite(commission) || commission < 0 || commission > collected) {
      return { status: 'error', message: 'Invalid commission amount.' };
    }

    return await withImmediateTransaction(async () => {
      const session = await getAsync(
        `SELECT * FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
      );
      const sessionUserType = session ? decryptValue('session', session[C.session.user_type]) : null;
      if (!session || !session[C.session.user_id] || !session[C.session.shop_id] || sessionUserType !== 'shop_user') {
        throw new Error('Your local session has expired. Please log in again.');
      }

      const userId = session[C.session.user_id];
      const shopId = session[C.session.shop_id];
      const shop = await getAsync(
        `SELECT ${C.shops.current_balance} AS bal, ${C.shops.sales_record_count} AS cnt
         FROM ${T.shops} WHERE ${C.shops.shop_id} = ?`,
        [shopId]
      );
      if (!shop) throw new Error('Local shop record not found.');

      const currentBalance = decNum('shops', shop.bal);
      const roundedCommission = Math.round((commission + Number.EPSILON) * 100) / 100;
      const newBalance = Math.round((currentBalance - roundedCommission + Number.EPSILON) * 100) / 100;
      if (newBalance < 0) throw new Error('Insufficient local credit for this game.');

      await runAsync(
        `UPDATE ${T.shops}
         SET ${C.shops.current_balance} = ?, ${C.shops.sales_record_count} = ?
         WHERE ${C.shops.shop_id} = ?`,
        [
          encryptValue('shops', newBalance.toFixed(2)),
          encryptValue('shops', String(decInt('shops', shop.cnt) + 1)),
          shopId
        ]
      );

      const startedAt = nowSql();
      const result = await runAsync(`
        INSERT INTO ${T.sales} (
          ${C.sales.shop_id}, ${C.sales.user_id}, ${C.sales.no_cards}, ${C.sales.price},
          ${C.sales.collected}, ${C.sales.commission}, ${C.sales.balance_after_sales},
          ${C.sales.started_time}, ${C.sales.synced}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `, [
        shopId,
        userId,
        encryptValue('sales', String(noCards)),
        encryptValue('sales', price.toFixed(2)),
        encryptValue('sales', collected.toFixed(2)),
        encryptValue('sales', roundedCommission.toFixed(2)),
        encryptValue('sales', newBalance.toFixed(2)),
        startedAt
      ]);

      return {
        status: 'success',
        message: 'Game registered successfully',
        sales_id: result.lastID,
        started_time: startedAt,
        new_balance: newBalance
      };
    });
  } catch (error) {
    console.error('register-sales error:', error);
    return { status: 'error', message: error.message || 'Could not register this game.' };
  }
});

// Handle update-sales event
ipcMain.handle('update-sales', async (_event, data = {}) => {
  const { started_time, last_number, count } = data;

  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(started_time || ''))) {
    return { status: "error", message: "Missing started_time" };
  }
  if (last_number !== undefined && (!Number.isInteger(Number(last_number)) || Number(last_number) < 0 || Number(last_number) > 75)) {
    return { status: 'error', message: 'Invalid last called number.' };
  }
  if (count !== undefined && (!Number.isInteger(Number(count)) || Number(count) < 0 || Number(count) > 75)) {
    return { status: 'error', message: 'Invalid called-number count.' };
  }

  try {
    const active = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!active?.shop_id) return { status: 'error', message: 'No active local account.' };

    const fields = [];
    const params = [];

    if (last_number !== undefined) {
      fields.push(`${C.sales.on_call} = ?`);
      params.push(encryptValue('sales', Number(last_number)));
    }

    if (count !== undefined) {
      fields.push(`${C.sales.total_called} = ?`);
      params.push(encryptValue('sales', Number(count)));
    }

    const ended_time = (() => {
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    })();

    fields.push(`${C.sales.ended_time} = ?`);
    params.push(ended_time);

    params.push(started_time, active.shop_id);

    const sql = `UPDATE ${T.sales}
      SET ${fields.join(", ")}
      WHERE ${C.sales.started_time} = ?
        AND ${C.sales.shop_id} = ?
        AND ${C.sales.ended_time} IS NULL`;

    const result = await runAsync(sql, params);

    if (result.changes > 0) {
      return { status: "success", message: "Sales updated successfully", ended_time };
    } else {
      return { status: "error", message: "No matching record found or already ended" };
    }

  } catch (err) {
    console.error("Error updating sale:", err.message);
    return { status: "error", message: err.message };
  }
});

ipcMain.handle('get-daily-income', async (_event, data = {}) => {
  const fromDate = String(data.from_date || '');
  const toDate = String(data.to_date || '');

  if (!isIsoCalendarDate(fromDate) || !isIsoCalendarDate(toDate)) {
    return { status: "error", message: "Invalid date range", total: 0 };
  }
  if (fromDate > toDate) {
    return { status: "error", message: "The start date must not be after the end date", total: 0 };
  }

  try {
    const session = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!session || !session.shop_id) {
      return { status: "error", message: "No active session", total: 0 };
    }

    const shop_id = session.shop_id;

    const rows = await allAsync(`
      SELECT ${C.sales.commission} AS comm, ${C.sales.started_time} AS st
      FROM ${T.sales}
      WHERE ${C.sales.shop_id} = ?
    `, [shop_id]);

    let total = 0;
    for (const row of rows) {
      const dt = (row.st || '').slice(0, 10);
      if (dt >= fromDate && dt <= toDate) {
        total += decNum('sales', row.comm);
      }
    }

    return { status: "success", total: total.toFixed(2) };

  } catch (err) {
    console.error("Error fetching daily income:", err.message);
    return { status: "error", message: err.message, total: 0 };
  }
});

ipcMain.handle("get-shop-info", async () => {
  try {
    const session = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!session || !session.shop_id) {
      return { status: "error", message: "No active session found" };
    }

    const shop_id = session.shop_id;

    const shop = await getAsync(`
      SELECT ${C.shops.shop_name} AS sn, ${C.shops.shop_address} AS sa, ${C.shops.current_balance} AS cb
      FROM ${T.shops}
      WHERE ${C.shops.shop_id} = ?
    `, [shop_id]);

    if (!shop) {
      return { status: "error", message: "Shop not found" };
    }

    const now = new Date();
    const current_date = `${String(now.getDate()).padStart(2, "0")}:${String(now.getMonth() + 1).padStart(2, "0")}:${now.getFullYear()}`;

    return {
      status: "success",
      shop_id,
      shop_name: decryptValue('shops', shop.sn),
      shop_address: decryptValue('shops', shop.sa),
      current_balance: decNum('shops', shop.cb).toFixed(2),
      current_date
    };

  } catch (err) {
    console.error("get-shop-info error:", err);
    return { status: "error", message: err.message };
  }
});

ipcMain.handle('get-sales-history', async () => {
  try {
    const session = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!session || !session.shop_id) {
      return { status: "error", message: "No active session" };
    }

    const shop_id = session.shop_id;

    const rows = await allAsync(`
      SELECT ${C.sales.no_cards} AS nc, ${C.sales.price} AS pr, ${C.sales.collected} AS co,
             ${C.sales.commission} AS cm, ${C.sales.balance_after_sales} AS bas, ${C.sales.started_time} AS st
      FROM ${T.sales}
      WHERE ${C.sales.shop_id} = ?
      ORDER BY ${C.sales.started_time} ASC
    `, [shop_id]);

    if (!rows || rows.length === 0) {
      return { status: "success", data: [] };
    }

    const formatted = rows.map(row => {
      const started = new Date(row.st);
      const date = `${String(started.getDate()).padStart(2, "0")}:${String(started.getMonth() + 1).padStart(2, "0")}:${started.getFullYear()}`;
      const time = started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const collected = decNum('sales', row.co);
      const commission = decNum('sales', row.cm);
      const winner_price = collected - commission;

      return {
        no_cards: decInt('sales', row.nc),
        price: decNum('sales', row.pr),
        collected,
        winner_price,
        commission,
        balance_after_sales: decNum('sales', row.bas),
        time,
        date
      };
    });

    return { status: "success", data: formatted };

  } catch (err) {
    console.error("Error loading sales history:", err.message);
    return { status: "error", message: err.message };
  }
});

ipcMain.handle('review-balance', async (_event, commissionAmount) => {
  const requiredAmount = Number(commissionAmount);
  if (!Number.isFinite(requiredAmount) || requiredAmount < 0 || requiredAmount > 1_000_000_000) {
    return { status: 'error', message: 'Invalid commission amount.' };
  }
  try {
    const sessionRow = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!sessionRow?.shop_id) {
      return { status: 'error', message: 'የአስተዳዳሪ ክፍለ ጊዜ አልተገኘም።' };
    }
    const shop = await getAsync(
      `SELECT ${C.shops.current_balance} AS bal FROM ${T.shops} WHERE ${C.shops.shop_id} = ?`,
      [sessionRow.shop_id]
    );
    if (!shop) return { status: 'error', message: 'የሱቅ መረጃ አልተገኘም።' };

    const currentBalance = decNum('shops', shop.bal);
    if (currentBalance < requiredAmount) {
      return {
        status: 'insufficient',
        message: 'በቂ ቀሪ ሂሳብ የለም!',
        current_balance: currentBalance,
        required: requiredAmount
      };
    }
    return {
      status: 'ok',
      message: 'በቂ ቀሪ ሂሳብ አለ።',
      current_balance: currentBalance
    };
  } catch (error) {
    console.error('Balance review failed:', error);
    return { status: 'error', message: 'የዳታቤዝ ስህተት ተከስቷል።' };
  }
});

const LOW_BALANCE_THRESHOLD = 2000.00;

ipcMain.handle('notify-balance', async () => {
  try {
    const sessionRow = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!sessionRow?.shop_id) return { status: 'error', message: 'Failed to retrieve shop session.' };
    const shopRow = await getAsync(
      `SELECT ${C.shops.current_balance} AS bal, ${C.shops.shop_name} AS sn FROM ${T.shops} WHERE ${C.shops.shop_id} = ?`,
      [sessionRow.shop_id]
    );
    if (!shopRow) return { status: 'error', message: 'Shop information not found.' };

    const currentBalance = decNum('shops', shopRow.bal);
    const shopName = decryptValue('shops', shopRow.sn) || 'Your Shop';
    return currentBalance < LOW_BALANCE_THRESHOLD
      ? { status: 'low', message: `${shopName} has a low balance! Please fill credit with a signed voucher.`, balance: currentBalance }
      : { status: 'ok', message: `Current Balance: ${currentBalance.toFixed(2)}`, balance: currentBalance };
  } catch (error) {
    console.error('Balance notification failed:', error);
    return { status: 'error', message: 'Shop information not found.' };
  }
});

// GET shop settings (used by data.html and game.html)
ipcMain.handle('get-shop-setting', async () => {
  try {
    const session = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!session || !session.shop_id) {
      return { success: false, message: "No active session found" };
    }

    const shopId = session.shop_id;

    const row = await getAsync(`
        SELECT ${C.shop_settings.game_time_gap} AS gt, ${C.shop_settings.voices_game} AS vg, ${C.shop_settings.commission_game} AS cg
        FROM ${T.shop_settings}
        WHERE ${C.shop_settings.shop_id} = ?
      `, [shopId]);
    const storedCommission = row ? decryptValue('shop_settings', row.cg) || 'A' : 'A';
    const commissionSettings = parseCommissionSettings(storedCommission);
    const storedGap = row ? decInt('shop_settings', row.gt) : 5000;
    const gameTimeGap = Number.isInteger(storedGap) && storedGap >= 1000 && storedGap <= 10000
      ? storedGap
      : 5000;
    const storedVoice = row ? decryptValue('shop_settings', row.vg) : 'A';
    const voicesGame = ['A', 'O', 'TG', 'AF', 'T'].includes(storedVoice) ? storedVoice : 'A';
    return {
      success: true,
      settings: {
        gameTimeGap,
        voicesGame,
        commissionGame: commissionSettings.mode === 'preset' ? commissionSettings.preset : 'CUSTOM',
        commissionSettings
      }
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// UPDATE Game Time Gap
ipcMain.handle('update-game-time-gap', async (_event, gapMs) => {
  try {
    const normalizedGap = Number(gapMs);
    if (!Number.isInteger(normalizedGap) || normalizedGap < 1000 || normalizedGap > 10000) {
      return { success: false, message: 'Call timing must be between 1 and 10 seconds.' };
    }
    const session = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!session || !session.shop_id) {
      return { success: false, message: "No active session found" };
    }
    const shopId = session.shop_id;

    await runAsync(`
        INSERT INTO ${T.shop_settings} (
          ${C.shop_settings.shop_id}, ${C.shop_settings.game_time_gap},
          ${C.shop_settings.voices_game}, ${C.shop_settings.commission_game}
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(${C.shop_settings.shop_id})
        DO UPDATE SET ${C.shop_settings.game_time_gap} = excluded.${C.shop_settings.game_time_gap}
      `, [
        shopId,
        encryptValue('shop_settings', String(normalizedGap)),
        encryptValue('shop_settings', 'A'),
        encryptValue('shop_settings', 'A')
      ]);
    return { success: true, message: 'Call timing updated successfully' };
  } catch (error) {
    console.error('update-game-time-gap error:', error.message);
    return { success: false, message: error.message };
  }
});

// UPDATE Voices Game
ipcMain.handle('update-voices-game', async (_event, voiceCode) => {
  try {
    const normalizedVoice = String(voiceCode || '').trim();
    if (!['A', 'O', 'TG', 'AF', 'T'].includes(normalizedVoice)) {
      return { success: false, message: 'That voice is not installed.' };
    }
    const session = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!session || !session.shop_id) {
      return { success: false, message: "No active session found" };
    }
    const shopId = session.shop_id;

    await runAsync(`
        INSERT INTO ${T.shop_settings} (
          ${C.shop_settings.shop_id}, ${C.shop_settings.voices_game},
          ${C.shop_settings.game_time_gap}, ${C.shop_settings.commission_game}
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(${C.shop_settings.shop_id})
        DO UPDATE SET ${C.shop_settings.voices_game} = excluded.${C.shop_settings.voices_game}
      `, [
        shopId,
        encryptValue('shop_settings', normalizedVoice),
        encryptValue('shop_settings', '5000'),
        encryptValue('shop_settings', 'A')
      ]);
    return { success: true, message: 'Call voice updated successfully' };
  } catch (error) {
    console.error('update-voices-game error:', error.message);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('update-commission-game', async (_event, requestedSettings) => {
  let commissionSettings;
  try {
    commissionSettings = validateCommissionSettings(requestedSettings);
  } catch (error) {
    return { success: false, message: error.message };
  }

  try {
    const session = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!session || !session.shop_id) {
      return { success: false, message: "No active session found" };
    }
    const shopId = session.shop_id;

    await runAsync(`
        INSERT INTO ${T.shop_settings} (
          ${C.shop_settings.shop_id}, ${C.shop_settings.commission_game}, ${C.shop_settings.game_time_gap}, ${C.shop_settings.voices_game}
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(${C.shop_settings.shop_id}) DO UPDATE SET
          ${C.shop_settings.commission_game} = excluded.${C.shop_settings.commission_game}
      `, [
        shopId,
        encryptValue('shop_settings', serializeCommissionSettings(commissionSettings)),
        encryptValue('shop_settings', '5000'),
        encryptValue('shop_settings', 'A')
      ]);
    return {
      success: true,
      message: 'Commission updated successfully',
      settings: commissionSettings
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('calculate-game-commission', async (_event, selectedCards) => {
  try {
    const count = Number(selectedCards);
    const active = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!active?.shop_id) return { success: false, message: 'No active local account.' };

    const row = await getAsync(`
      SELECT ${C.shop_settings.commission_game} AS commission_game
      FROM ${T.shop_settings}
      WHERE ${C.shop_settings.shop_id} = ?
      LIMIT 1
    `, [active.shop_id]);
    const stored = row ? decryptValue('shop_settings', row.commission_game) || 'A' : 'A';
    const settings = parseCommissionSettings(stored);
    const percent = calculateCommissionPercent(settings, count);
    return { success: true, percent, selected_cards: count, settings };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// ============================================================
// open-game-page — local session and credit checks
// ============================================================
ipcMain.on('open-game-page', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  try {
    const activeSession = await getAsync(
      `SELECT ${C.session.shop_id} AS shop_id FROM ${T.session} WHERE ${C.session.active} = 1 LIMIT 1`
    );
    if (!activeSession?.shop_id) {
      await win.loadFile(DASHBOARD_PAGE);
      await win.webContents.executeJavaScript(`displayError("Session expired. Please log in again.");`);
      return;
    }
    const shop = await getAsync(
      `SELECT ${C.shops.current_balance} AS bal, ${C.shops.shop_name} AS sn FROM ${T.shops} WHERE ${C.shops.shop_id} = ?`,
      [activeSession.shop_id]
    );
    if (!shop) {
      await win.loadFile(DASHBOARD_PAGE);
      await win.webContents.executeJavaScript(`displayError("Shop data not found.");`);
      return;
    }

    const balance = decNum('shops', shop.bal);
    const shopName = decryptValue('shops', shop.sn) || 'Shop';
    if (balance >= 100) {
      await win.loadFile(GAME_PAGE);
      console.log(`Game access granted for shop ${shopName} (balance: ${balance})`);
    } else {
      await win.loadFile(NO_BALANCE_PAGE);
      console.log(`Game access denied: low balance (${balance})`);
    }
  } catch (error) {
    writeStartupLog('ERROR', `Could not open the game page: ${errorDetails(error)}`);
    await win.loadFile(DASHBOARD_PAGE).catch(() => {});
  }
});

// ============================================================
// DevTools lock
// ============================================================
ipcMain.on('devtools-opened', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  if (win.__devtoolsLocked) return;
  win.__devtoolsLocked = true;

  console.warn('⚠️ DevTools opened — locking window.');

  win.loadFile(LOCKED_PAGE);
});

ipcMain.on('quit-app', () => {
  requestGracefulQuit();
});

function closeDatabase() {
  if (databaseClosePromise) return databaseClosePromise;
  if (!db) return Promise.resolve();

  const database = db;
  db = null;
  databaseClosePromise = new Promise(resolve => {
    try {
      database.close(error => {
        if (error) writeStartupLog('ERROR', `Could not close SQLite cleanly: ${errorDetails(error)}`);
        resolve();
      });
    } catch (error) {
      writeStartupLog('ERROR', `Could not close SQLite cleanly: ${errorDetails(error)}`);
      resolve();
    }
  });
  return databaseClosePromise;
}

function shutdownResources() {
  if (shutdownPromise) return shutdownPromise;
  stopBalanceReconciler();
  stopSalesChecker();
  shutdownPromise = Promise.allSettled([
    mobileRoom.stop(),
    databaseQueue.then(() => closeDatabase())
  ]).then(results => {
    for (const result of results) {
      if (result.status === 'rejected') {
        writeStartupLog('ERROR', `Shutdown task failed: ${errorDetails(result.reason)}`);
      }
    }
  });
  return shutdownPromise;
}

async function requestGracefulQuit(event) {
  if (allowImmediateQuit) return;
  event?.preventDefault?.();
  await shutdownResources();
  if (allowImmediateQuit) return;
  allowImmediateQuit = true;
  app.quit();
}

async function loadAuthorizedEntry(win) {
  const status = licenseService.getStatus();
  if (!status.valid) {
    await win.loadFile(ACTIVATION_PAGE);
    return;
  }

  const loginPage = path.join(__dirname, 'renderer', 'index.html');
  const dashboardPage = path.join(__dirname, 'renderer', 'shop', 'dashboard', 'control.html');
  const row = await getAsync(
    `SELECT s.${C.session.shop_id} AS shop_id
       FROM ${T.session} s
       INNER JOIN ${T.local_accounts} a
         ON a.${C.local_accounts.user_id} = s.${C.session.user_id}
        AND a.${C.local_accounts.shop_id} = s.${C.session.shop_id}
       WHERE s.${C.session.active} = 1
       LIMIT 1`
  );
  await win.loadFile(row ? dashboardPage : loginPage);
}

// --- Create Window and Initialize DB ---
function createWindow() {
  try {
    migrateLegacyPortableData();
    if (sqliteLoadError || !sqlite3) {
      throw sqliteLoadError || new Error('The SQLite module is unavailable.');
    }

    Menu.setApplicationMenu(null);
    configureOfflineNetworkGuard();

    const dbFolder = path.join(userDataRoot, 'database');
    if (!fs.existsSync(dbFolder)) fs.mkdirSync(dbFolder, { recursive: true });
    const dbPath = path.join(dbFolder, 'local.db');
    const bundledSeedDb = path.join(__dirname, 'database', 'local.db');
    if (!fs.existsSync(dbPath) && fs.existsSync(bundledSeedDb) && fs.statSync(bundledSeedDb).size > 0) {
      fs.copyFileSync(bundledSeedDb, dbPath);
      console.log('Seeded the local database from the supplied profile.');
    }
    console.log(`Connecting to database at: ${dbPath}`);

    db = new sqlite3.Database(dbPath, async (err) => {
      if (err) {
        reportStartupFailure('The local database could not be opened.', err);
        app.quit();
        return;
      }

      try {
        console.log('Database connected successfully.');
        db.on?.('error', error => {
          writeStartupLog('ERROR', `SQLite runtime error: ${errorDetails(error)}`);
        });
        await createTables(db);

        startBalanceReconciler();
        startSalesChecker();

        const win = new BrowserWindow({
          width: 1200,
          height: 800,
          show: false,
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            devTools: false
          }
        });

        win.once('ready-to-show', () => {
          if (startupSmokeTest) {
            writeStartupLog('INFO', 'PACKAGED_SMOKE_TEST_READY');
            shutdownResources().finally(() => app.exit(0));
            return;
          }
          win.show();
        });
        secureWebContents(win.webContents);

        // ⭐ did-finish-load: DevTools detection injection + game page unsynced-sales check
        win.webContents.on('did-finish-load', async () => {
          const currentUrl = win.webContents.getURL();
          if (currentUrl.includes('locked.html')) return;

          win.webContents.executeJavaScript(
            'if (window.api && window.api.startDevToolsDetection) { window.api.startDevToolsDetection(); }'
          ).catch(error => console.error('DevTools detection injection failed:', error));
        });

        loadAuthorizedEntry(win).catch(error => {
          writeStartupLog('ERROR', `Could not load the authorized entry page.\n${errorDetails(error)}`);
          win.loadFile(ACTIVATION_PAGE).catch(fallbackError => {
            reportStartupFailure('The application screen could not be loaded.', fallbackError);
            app.quit();
          });
        });
      } catch (error) {
        reportStartupFailure('The application window could not be created.', error);
        app.quit();
      }
    });
  } catch (error) {
    reportStartupFailure('Africa Bingo Local failed during startup.', error);
    app.quit();
  }
}

if (hasSingleInstanceLock) {
  app.whenReady().then(createWindow).catch(error => {
    reportStartupFailure('Electron could not finish starting.', error);
    app.quit();
  });
}

app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    await requestGracefulQuit();
  }
});

app.on('before-quit', event => {
  if (!allowImmediateQuit) requestGracefulQuit(event);
});

process.on('uncaughtException', error => {
  reportStartupFailure('An unexpected main-process error stopped the application.', error);
  app.quit();
});

process.on('unhandledRejection', error => {
  reportStartupFailure('An unexpected startup task failed.', error);
  app.quit();
});

