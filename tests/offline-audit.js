'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'main.js');
const preloadPath = path.join(root, 'preload.js');
const mobileRoomPath = path.join(root, 'mobile-room.js');
const voucherServicePath = path.join(root, 'voucher-service.js');
const commissionSettingsPath = path.join(root, 'commission-settings.js');
const licenseServicePath = path.join(root, 'license-service.js');
const gamePath = path.join(root, 'renderer', 'shop', 'game', 'game.html');
const dataPath = path.join(root, 'renderer', 'shop', 'data', 'data.html');
const workflowPath = path.join(root, '.github', 'workflows', 'windows-release.yml');
const main = fs.readFileSync(mainPath, 'utf8');
const preload = fs.readFileSync(preloadPath, 'utf8');
const mobileRoom = fs.readFileSync(mobileRoomPath, 'utf8');
const voucherService = fs.readFileSync(voucherServicePath, 'utf8');
const commissionSettings = fs.readFileSync(commissionSettingsPath, 'utf8');
const licenseService = fs.readFileSync(licenseServicePath, 'utf8');
const game = fs.readFileSync(gamePath, 'utf8');
const dataPage = fs.readFileSync(dataPath, 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');

for (const forbidden of [
  'africabingo.duckdns.org', "require('axios')", 'electron-updater', 'autoUpdater',
  'sync-heartbeat', 'sync-deposits', 'sync-sales', 'trigger-sync', 'sync-update-message'
]) {
  assert.equal(main.includes(forbidden), false, `forbidden remote dependency found: ${forbidden}`);
  assert.equal(preload.includes(forbidden), false, `forbidden remote IPC surface found: ${forbidden}`);
}

for (const scheme of ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*']) {
  assert.equal(main.includes(scheme), true, `network guard is missing ${scheme}`);
}

assert.match(main, /callback\(\{ cancel: true \}\)/, 'remote request guard must cancel requests');
assert.match(main, /enableNetworkEmulation\?\.\(\{ offline: true \}\)/, 'Chromium must be forced offline');
assert.match(main, /setPermissionRequestHandler[\s\S]*callback\(false\)/, 'permission requests must be denied');
assert.match(main, /disableNodeNetworking\(\)/, 'Node networking deny layer is missing');
assert.match(main, /net\.Socket\.prototype\.connect = denyNodeNetwork/, 'raw TCP sockets must be denied');
assert.match(main, /dgram\.createSocket = denyNodeNetwork/, 'UDP sockets must be denied');
assert.match(main, /host-resolver-rules[\s\S]*MAP \* ~NOTFOUND/, 'Chromium DNS must be disabled');
assert.match(main, /disable-background-networking/, 'Chromium background networking must be disabled');
assert.match(main, /will-attach-webview/, 'webviews must be denied');
assert.match(main, /sandbox: true/, 'renderer sandbox must be enabled');
assert.match(main, /create-local-account/, 'local account handler is missing');
assert.match(main, /redeem-credit-voucher/, 'signed voucher handler is missing');
assert.match(main, /BEGIN IMMEDIATE TRANSACTION/, 'voucher redemption must use an immediate transaction');
assert.match(main, /voucher_redemptions/, 'voucher replay ledger is missing');
assert.match(main, /MobileRoom/, 'private mobile cartela room is missing');
assert.match(main, /calculate-game-commission/, 'local game commission calculator is missing');
assert.match(main, /get-device-activation-status/, 'first-run device activation status handler is missing');
assert.match(main, /activate-device-license/, 'signed device activation handler is missing');
assert.match(main, /loadAuthorizedEntry/, 'startup device-activation gate is missing');
assert.match(main, /app\.getPath\('userData'\)/, 'local data must use Electron userData');
assert.equal(
  main.includes("app.setPath('userData'"),
  false,
  'startup must not redirect userData to a missing or protected installation folder'
);
assert.match(main, /migrateLegacyPortableData/, 'legacy portable data migration is missing');
assert.match(main, /showErrorBox/, 'silent startup failures must display a native error');
assert.match(main, /unhandledRejection/, 'startup promise failures must be captured');
assert.match(main, /requestSingleInstanceLock/, 'multiple app instances must not share one SQLite database');
assert.match(main, /PRAGMA quick_check/, 'startup must verify SQLite integrity');
assert.match(main, /withImmediateTransaction/, 'credit and sales writes must use the transaction queue');
assert.match(main, /AsyncLocalStorage/, 'SQLite operations must not leak into another handler transaction');
assert.match(main, /databaseQueue/, 'SQLite operations must share one operation gate');
assert.match(main, /--smoke-test/, 'the packaged startup smoke mode is missing');
assert.match(workflow, /Launch packaged Windows app/, 'Windows CI must launch the packaged executable');
assert.match(main, /serializeCommissionSettings/, 'custom commission settings are not stored through the validator');
assert.equal(main.includes('add-local-credit'), false, 'manual credit handler must not exist');
assert.equal(preload.includes('addLocalCredit'), false, 'manual credit API must not exist');
assert.match(main, /crypto\.scrypt/, 'password hashing must use scrypt');

assert.match(voucherService, /crypto\.verify\(null, payloadBytes/, 'voucher signatures must be verified');
assert.match(voucherService, /This voucher belongs to another computer/, 'vouchers must be device-bound');
assert.equal(voucherService.includes('PRIVATE KEY'), false, 'a voucher private key must never ship in the app');

assert.match(licenseService, /crypto\.verify\(null, Buffer\.from\(payloadBase64/, 'activation signatures must be verified');
assert.match(licenseService, /This activation belongs to another computer/, 'activation must be device-bound');
assert.equal(licenseService.includes('PRIVATE KEY'), false, 'a license private key must never ship in the app');

assert.match(commissionSettings, /\['preset', 'manual', 'auto', 'interval'\]/, 'custom commission modes are incomplete');
assert.match(commissionSettings, /ranges cannot overlap/, 'custom commission ranges must reject overlaps');
assert.equal(/(?:https?|wss?|ftp):\/\//i.test(commissionSettings), false, 'commission settings must stay local');

assert.match(mobileRoom, /http\.createServer/, 'local mobile room server is missing');
assert.match(mobileRoom, /server\.listen\(port\)/, 'local listener must start without a DNS lookup');
assert.match(mobileRoom, /isAllowedClientAddress/, 'mobile requests must be restricted to private clients');
assert.match(mobileRoom, /crypto\.randomBytes\(18\)/, 'mobile room must use a random session secret');
assert.match(mobileRoom, /mode = 'approval'/, 'mobile devices must require host approval');
assert.equal(/listen\([^\n]+(?:80|443)[),]/.test(mobileRoom), false, 'mobile room must not use public web ports');
assert.match(mobileRoom, /closeAllConnections/, 'mobile room shutdown must have a bounded forced-close path');
assert.match(mobileRoom, /MAX_CLIENTS/, 'mobile room must cap remembered phone clients');

const voiceCodes = [...dataPage.matchAll(/class="voice_box" data-voice="([^"]+)"/g)]
  .map(match => match[1]);
for (const voiceCode of voiceCodes) {
  for (let number = 1; number <= 75; number += 1) {
    const fileCode = voiceCode === 'O' && number >= 61 ? 'o' : voiceCode;
    assert.equal(
      fs.existsSync(path.join(root, 'renderer', 'shop', 'game', 'audio', `${fileCode}${number}.mp3`)),
      true,
      `missing bundled audio for voice ${voiceCode}, number ${number}`
    );
  }
}
assert.equal(/\baudio\.onended\s*=/.test(game), false, 'game page references an undefined audio object');

const handlers = new Set(
  [...main.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)].map(match => match[1])
);
const channels = new Set(
  [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map(match => match[1])
);
for (const channel of channels) {
  assert.equal(handlers.has(channel), true, `preload channel has no main-process handler: ${channel}`);
}

const htmlFiles = [];
function collectHtml(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectHtml(fullPath);
    else if (entry.name.endsWith('.html')) htmlFiles.push(fullPath);
  }
}
collectHtml(path.join(root, 'renderer'));
collectHtml(path.join(root, 'mobile'));

for (const htmlPath of htmlFiles) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(
    html,
    /Content-Security-Policy/i,
    `CSP missing from ${path.relative(root, htmlPath)}`
  );
  assert.equal(
    /(?:src|href)=["']https?:\/\//i.test(html),
    false,
    `remote HTML resource found: ${path.relative(root, htmlPath)}`
  );
  const executableHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const [index, match] of [...executableHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].entries()) {
    if (match[1].trim()) {
      assert.doesNotThrow(
        () => new vm.Script(match[1], { filename: `${htmlPath}:inline-${index + 1}` }),
        `invalid inline JavaScript in ${path.relative(root, htmlPath)}`
      );
    }
  }
}

const firstPartyFiles = [];
function collectFirstParty(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'africa-bingo-local-data') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFirstParty(fullPath);
    else if (/\.(?:js|html|json|md)$/i.test(entry.name) && entry.name !== 'package-lock.json') {
      firstPartyFiles.push(fullPath);
    }
  }
}
collectFirstParty(root);

for (const filePath of firstPartyFiles) {
  if (filePath === mainPath || filePath.startsWith(path.join(root, 'tests'))) continue;
  let source = fs.readFileSync(filePath, 'utf8')
    .replaceAll('http://www.w3.org/2000/svg', '')
    .replaceAll('http://www.w3.org/1999/xlink', '')
    .replaceAll('http://www.w3.org/2000/xmlns/', '');
  if (filePath === mobileRoomPath) {
    source = source
      .replace('`http://127.0.0.1:${this.port}`', '')
      .replace('`http://${address}:${this.port}/join?session=${encodeURIComponent(this.sessionToken)}`', '')
      .replace("'http://local.invalid'", '');
  }
  assert.equal(
    /(?:https?|wss?|ftp):\/\//i.test(source),
    false,
    `server URL found in ${path.relative(root, filePath)}`
  );
  assert.equal(
    /(?:duckdns|\.php\b|axios|electron-updater|autoUpdater)/i.test(source),
    false,
    `server-era code found in ${path.relative(root, filePath)}`
  );
}

console.log(`offline audit passed (${handlers.size} IPC handlers, ${htmlFiles.length} HTML files)`);
