'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 32 * 1024;

function normalizeMode(mode) {
  return mode === 'open' ? 'open' : 'approval';
}

function isPrivateIPv4(address) {
  return (
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

function normalizeRemoteAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function isAllowedClientAddress(address) {
  const value = normalizeRemoteAddress(address);
  return Boolean(
    value === '::1' ||
    value === '127.0.0.1' ||
    value.startsWith('127.') ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe80:') ||
    isPrivateIPv4(value)
  );
}

function isIPv4Family(family) {
  return family === 'IPv4' || family === 4;
}

function isUsableIPv4(address) {
  return Boolean(
    address &&
    address !== '0.0.0.0' &&
    !address.startsWith('127.') &&
    !address.startsWith('169.254.')
  );
}

function networkAddressScore(candidate) {
  let score = 0;
  const address = candidate.address || '';
  const name = candidate.interfaceName || '';

  if (
    address === '192.168.137.1' ||
    address === '192.168.173.1'
  ) {
    score += 500;
  }

  if (
    /mobile hotspot|wi-?fi direct|local area connection\*|hosted network|tether/i
      .test(name)
  ) {
    score += 300;
  }

  if (/vEthernet/i.test(name)) {
    score += 120;
  }

  if (isPrivateIPv4(address)) {
    score += 100;
  }

  if (/\.1$/.test(address)) {
    score += 20;
  }

  return score;
}

function getNetworkIPv4Candidates() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (
        isIPv4Family(entry.family) &&
        !entry.internal &&
        isUsableIPv4(entry.address)
      ) {
        if (!isPrivateIPv4(entry.address)) continue;
        candidates.push({
          address: entry.address,
          interfaceName,
          private: isPrivateIPv4(entry.address)
        });
      }
    }
  }

  candidates.sort((a, b) => {
    const scoreDifference =
      networkAddressScore(b) - networkAddressScore(a);

    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    return a.interfaceName.localeCompare(b.interfaceName);
  });

  return candidates;
}

function getLocalIPv4(preferredAddress = null) {
  const candidates = getNetworkIPv4Candidates();

  if (preferredAddress) {
    const exact = candidates.find(
      (candidate) => candidate.address === preferredAddress
    );

    if (exact) {
      return exact.address;
    }
  }

  return candidates[0]?.address || '127.0.0.1';
}

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(data);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON request.'));
      }
    });

    req.on('error', reject);
  });
}

class MobileRoom extends EventEmitter {
  constructor(options = {}) {
    super();
    this.assetsDir = options.assetsDir || path.join(__dirname, 'mobile');
    this.server = null;
    this.port = null;
    this.running = false;
    this.sessionToken = null;
    this.mode = 'approval';
    this.selectionOpen = true;
    this.roundNumber = 1;
    this.totalCards = 0;
    this.cartelaType = null;
    this.cartelaLabel = null;
    this.selectedOwners = new Map();
    this.clients = new Map();
    this.streams = new Map();
    this.heartbeatTimer = null;
    this.addressCache = { value: null, expiresAt: 0 };
    this.preferredAddress = null;
  }

  getNetworkAddresses() {
    return getNetworkIPv4Candidates();
  }

  refreshNetworkAddress() {
    this.addressCache = {
      value: null,
      expiresAt: 0
    };

    if (
      this.preferredAddress &&
      !this.getNetworkAddresses().some(
        (candidate) => candidate.address === this.preferredAddress
      )
    ) {
      this.preferredAddress = null;
    }

    return this.getStatus();
  }

  setPreferredAddress(address) {
    const requested = String(address || '').trim();

    if (!requested || requested === 'auto') {
      this.preferredAddress = null;
      return this.refreshNetworkAddress();
    }

    const exists = this.getNetworkAddresses().some(
      (candidate) => candidate.address === requested
    );

    if (!exists) {
      const error = new Error(
        'That network address is no longer available on this computer.'
      );
      error.code = 'NETWORK_ADDRESS_UNAVAILABLE';
      throw error;
    }

    this.preferredAddress = requested;
    this.addressCache = {
      value: requested,
      expiresAt: Date.now() + 2000
    };

    this.emitStatus();
    return this.getStatus();
  }

  getLocalAddress() {
    const now = Date.now();

    if (
      this.addressCache.value &&
      this.addressCache.value !== '127.0.0.1' &&
      now < this.addressCache.expiresAt
    ) {
      return this.addressCache.value;
    }

    const value = getLocalIPv4(this.preferredAddress);

    this.addressCache = {
      value,
      expiresAt:
        value === '127.0.0.1'
          ? 0
          : now + 2000
    };

    return value;
  }

  getStatus() {
    const address = this.getLocalAddress();
    const networkAddresses = this.getNetworkAddresses();
    const selectedCartelaCounts = new Map();

    for (const ownerId of this.selectedOwners.values()) {
      if (ownerId !== 'desktop') {
        selectedCartelaCounts.set(
          ownerId,
          (selectedCartelaCounts.get(ownerId) || 0) + 1
        );
      }
    }

    const clients = Array.from(this.clients.values())
      .map((client) => ({
        id: client.id,
        name: client.name,
        approved: this.mode === 'open' ? true : Boolean(client.approved),
        denied: Boolean(client.denied),
        connected: Boolean(client.connected),
        selectedCartelaCount: selectedCartelaCounts.get(client.id) || 0,
        lastSeen: client.lastSeen || null
      }))
      .sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        return (b.lastSeen || '').localeCompare(a.lastSeen || '');
      });

    const selectedCards = Array.from(this.selectedOwners.keys())
      .sort((a, b) => a - b);

    return {
      running: this.running,
      mode: this.mode,
      selectionOpen: this.selectionOpen,
      roundNumber: this.roundNumber,
      totalCards: this.totalCards,
      cartelaType: this.cartelaType,
      cartelaLabel: this.cartelaLabel,
      selectedCards,
      port: this.port,
      address,
      preferredAddress: this.preferredAddress,
      networkAddresses,
      localOnlyAddress: this.running && this.port
        ? `http://127.0.0.1:${this.port}`
        : null,
      connectUrl: this.running && this.port && this.sessionToken
        ? `http://${address}:${this.port}/join?session=${encodeURIComponent(this.sessionToken)}`
        : null,
      roomCode: this.sessionToken
        ? this.sessionToken.slice(0, 6).toUpperCase()
        : null,
      connectedCount: clients.filter((client) => client.connected).length,
      approvedCount: clients.filter((client) => client.approved && !client.denied).length,
      clients
    };
  }

  getClientState(clientId) {
    const base = this.getStatus();
    const client = clientId ? this.clients.get(clientId) : null;
    const approved = this.mode === 'open' || Boolean(client?.approved);
    const denied = Boolean(client?.denied);

    const mySelectedCards = [];
    if (clientId) {
      for (const [cardId, ownerId] of this.selectedOwners.entries()) {
        if (ownerId === clientId) mySelectedCards.push(cardId);
      }
      mySelectedCards.sort((a, b) => a - b);
    }

    return {
      running: base.running,
      mode: base.mode,
      selectionOpen: base.selectionOpen,
      roundNumber: base.roundNumber,
      totalCards: base.totalCards,
      cartelaType: base.cartelaType,
      cartelaLabel: base.cartelaLabel,
      selectedCards: base.selectedCards,
      mySelectedCards,
      approved: approved && !denied,
      denied,
      connectedCount: base.connectedCount,
      bingoName: this.bingoName || 'Africa Bingo Local'
    };
  }

  emitStatus() {
    this.emit('status-changed', this.getStatus());
  }

  broadcastState() {
    for (const [clientId, response] of this.streams.entries()) {
      this.writeEvent(response, 'state', this.getClientState(clientId));
    }
  }

  writeEvent(response, eventName, payload) {
    try {
      response.write(`event: ${eventName}\n`);
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // The close handler will clean up the stream.
    }
  }

  registerClient(clientId, name) {
    if (!clientId || typeof clientId !== 'string' || clientId.length > 100) {
      throw new Error('Invalid client ID.');
    }

    const cleanName = String(name || 'Player')
      .trim()
      .replace(/[\r\n\t]/g, ' ')
      .slice(0, 40) || 'Player';

    const existing = this.clients.get(clientId) || {
      id: clientId,
      approved: false,
      denied: false,
      connected: false,
      lastSeen: null
    };

    existing.name = cleanName;
    existing.lastSeen = new Date().toISOString();

    if (this.mode === 'open') {
      existing.approved = true;
      existing.denied = false;
    }

    this.clients.set(clientId, existing);
    this.emitStatus();
    return existing;
  }

  validateSession(token) {
    if (!this.running || !token || !this.sessionToken) {
      return false;
    }

    const provided = Buffer.from(String(token));
    const expected = Buffer.from(String(this.sessionToken));

    if (provided.length !== expected.length) {
      return false;
    }

    return crypto.timingSafeEqual(provided, expected);
  }

  setMode(mode) {
    this.mode = normalizeMode(mode);

    if (this.mode === 'open') {
      for (const client of this.clients.values()) {
        client.approved = true;
        client.denied = false;
      }
    }

    this.broadcastState();
    this.emitStatus();
    return this.getStatus();
  }

  approveClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) throw new Error('Device not found.');
    client.approved = true;
    client.denied = false;
    client.lastSeen = new Date().toISOString();
    this.broadcastState();
    this.emitStatus();
    return this.getStatus();
  }

  denyClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) throw new Error('Device not found.');
    client.approved = false;
    client.denied = true;
    client.lastSeen = new Date().toISOString();

    // A denied device cannot keep cards reserved.
    for (const [cardId, ownerId] of Array.from(this.selectedOwners.entries())) {
      if (ownerId === clientId) {
        this.selectedOwners.delete(cardId);
        this.emit('card-changed', {
          cardId,
          selected: false,
          source: 'mobile',
          ownerId: clientId
        });
      }
    }

    this.broadcastState();
    this.emitStatus();
    return this.getStatus();
  }

  setDesktopCard(cardId, selected) {
    return this.setCard(cardId, selected, {
      source: 'desktop',
      ownerId: 'desktop'
    });
  }

  setCard(cardId, selected, options = {}) {
    const id = Number(cardId);
    if (!Number.isInteger(id) || id < 1 || id > this.totalCards) {
      const error = new Error('Invalid cartela number.');
      error.code = 'INVALID_CARD';
      throw error;
    }

    if (!this.selectionOpen) {
      const error = new Error('Cartela selection is locked for this game.');
      error.code = 'SELECTION_LOCKED';
      throw error;
    }

    const source = options.source || 'desktop';
    const ownerId = options.ownerId || 'desktop';
    const currentOwner = this.selectedOwners.get(id);

    if (source === 'mobile') {
      if (selected) {
        if (currentOwner && currentOwner !== ownerId) {
          const error = new Error('That cartela has already been selected.');
          error.code = 'CARD_TAKEN';
          throw error;
        }
        this.selectedOwners.set(id, ownerId);
      } else {
        if (currentOwner && currentOwner !== ownerId) {
          const error = new Error('You can only unselect your own cartela.');
          error.code = 'NOT_OWNER';
          throw error;
        }
        this.selectedOwners.delete(id);
      }
    } else if (selected) {
      this.selectedOwners.set(id, ownerId);
    } else {
      this.selectedOwners.delete(id);
    }

    this.emit('card-changed', {
      cardId: id,
      selected: Boolean(selected),
      source,
      ownerId
    });

    this.broadcastState();
    this.emitStatus();
    return this.getStatus();
  }

  configureDeck(options = {}) {
    const totalCards = Number(options.totalCards);

    if (!Number.isInteger(totalCards) || totalCards < 1 || totalCards > 10000) {
      throw new Error('Invalid total cartela count.');
    }

    const nextType = options.cartelaType
      ? String(options.cartelaType).slice(0, 120)
      : null;

    const nextLabel = options.cartelaLabel
      ? String(options.cartelaLabel).slice(0, 160)
      : nextType;

    const selectedCards = Array.isArray(options.selectedCards)
      ? options.selectedCards
      : [];

    this.totalCards = totalCards;
    this.cartelaType = nextType;
    this.cartelaLabel = nextLabel;

    this.selectedOwners.clear();

    for (const rawCardId of selectedCards) {
      const cardId = Number(rawCardId);
      if (
        Number.isInteger(cardId) &&
        cardId >= 1 &&
        cardId <= totalCards
      ) {
        this.selectedOwners.set(cardId, 'desktop');
      }
    }

    // Changing the cartela deck is a setup action, so selection is open.
    this.selectionOpen = true;

    this.broadcastState();
    this.emitStatus();

    return this.getStatus();
  }

  lockSelection() {
    if (!this.running) return this.getStatus();
    this.selectionOpen = false;
    this.broadcastState();
    this.emitStatus();
    return this.getStatus();
  }

  openSelection() {
    if (!this.running) return this.getStatus();
    this.selectionOpen = true;
    this.broadcastState();
    this.emitStatus();
    return this.getStatus();
  }

  newRound() {
    if (!this.running) return this.getStatus();
    this.roundNumber += 1;
    this.selectionOpen = true;
    this.selectedOwners.clear();
    this.broadcastState();
    this.emit('round-changed', this.getStatus());
    this.emitStatus();
    return this.getStatus();
  }

  async start(options = {}) {
    const mode = normalizeMode(options.mode);
    const totalCards = Number(options.totalCards);
    const selectedCards = Array.isArray(options.selectedCards)
      ? options.selectedCards
      : [];

    const cartelaType = options.cartelaType
      ? String(options.cartelaType).slice(0, 120)
      : null;

    const cartelaLabel = options.cartelaLabel
      ? String(options.cartelaLabel).slice(0, 160)
      : cartelaType;

    if (!Number.isInteger(totalCards) || totalCards < 1 || totalCards > 10000) {
      throw new Error('Invalid total cartela count.');
    }

    if (this.running) {
      this.mode = mode;
      this.totalCards = totalCards;
      this.cartelaType = cartelaType;
      this.cartelaLabel = cartelaLabel;
      this.bingoName = String(options.bingoName || this.bingoName || 'Africa Bingo Local').slice(0, 80);
      this.broadcastState();
      this.emitStatus();
      return this.getStatus();
    }

    this.mode = mode;
    this.totalCards = totalCards;
    this.cartelaType = cartelaType;
    this.cartelaLabel = cartelaLabel;
    this.bingoName = String(options.bingoName || 'Africa Bingo Local').slice(0, 80);
    this.selectionOpen = true;
    this.roundNumber = 1;
    this.selectedOwners.clear();
    this.clients.clear();
    this.streams.clear();
    this.sessionToken = crypto.randomBytes(18).toString('base64url');
    this.addressCache = { value: null, expiresAt: 0 };

    for (const rawCardId of selectedCards) {
      const cardId = Number(rawCardId);
      if (Number.isInteger(cardId) && cardId >= 1 && cardId <= totalCards) {
        this.selectedOwners.set(cardId, 'desktop');
      }
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        console.error('Mobile room request failed:', error);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: 'Local room request failed.' });
        } else {
          res.end();
        }
      });
    });

    this.server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    let lastError = null;
    for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 10; port += 1) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            this.server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            this.server.off('error', onError);
            resolve();
          };
          this.server.once('error', onError);
          this.server.once('listening', onListening);
          // Omitting a hostname binds the local listener on all interfaces
          // without performing DNS lookup. Private-client filtering still
          // happens before any route or room data is served.
          this.server.listen(port);
        });
        this.port = port;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (error.code !== 'EADDRINUSE') break;
      }
    }

    if (lastError || !this.port) {
      const error = lastError || new Error('Could not start local room server.');
      try { this.server.close(); } catch {}
      this.server = null;
      this.sessionToken = null;
      throw error;
    }

    this.running = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      for (const response of this.streams.values()) {
        try { response.write(': heartbeat\n\n'); } catch {}
      }
    }, 20000);

    this.heartbeatTimer.unref?.();

    this.emitStatus();
    return this.getStatus();
  }

  async stop() {
    if (!this.running && !this.server) return this.getStatus();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const response of this.streams.values()) {
      try {
        this.writeEvent(response, 'room-ended', { ended: true });
        response.end();
      } catch {}
    }

    this.streams.clear();

    const server = this.server;
    this.server = null;
    this.running = false;
    this.port = null;
    this.sessionToken = null;
    this.addressCache = { value: null, expiresAt: 0 };
    this.selectionOpen = true;
    this.cartelaType = null;
    this.cartelaLabel = null;
    this.selectedOwners.clear();
    this.clients.clear();

    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }

    this.emitStatus();
    return this.getStatus();
  }

  async handleRequest(req, res) {
    if (!isAllowedClientAddress(req.socket?.remoteAddress)) {
      sendText(res, 403, 'Private hotspot or LAN access only.');
      return;
    }

    const url = new URL(req.url || '/', 'http://local.invalid');

    const commonHeaders = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    };

    const serveFile = (filename, contentType) => {
      const filePath = path.join(this.assetsDir, filename);
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        ...commonHeaders,
        'Content-Type': contentType,
        'Content-Length': data.length
      });
      res.end(data);
    };

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/join')) {
      serveFile('index.html', 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/mobile.css') {
      serveFile('mobile.css', 'text/css; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/mobile.js') {
      serveFile('mobile.js', 'application/javascript; charset=utf-8');
      return;
    }

    const token = url.searchParams.get('session');
    if (!this.validateSession(token)) {
      sendJson(res, 403, { ok: false, error: 'This local room link is no longer valid.' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const clientId = url.searchParams.get('clientId') || '';
      const name = url.searchParams.get('name') || 'Player';
      if (clientId) this.registerClient(clientId, name);
      sendJson(res, 200, { ok: true, state: this.getClientState(clientId) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      const clientId = url.searchParams.get('clientId') || '';
      const name = url.searchParams.get('name') || 'Player';
      const client = this.registerClient(clientId, name);
      client.connected = true;
      client.lastSeen = new Date().toISOString();

      res.writeHead(200, {
        ...commonHeaders,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');

      const oldStream = this.streams.get(clientId);
      if (oldStream && oldStream !== res) {
        try { oldStream.end(); } catch {}
      }
      this.streams.set(clientId, res);
      this.writeEvent(res, 'state', this.getClientState(clientId));
      this.emitStatus();

      req.on('close', () => {
        if (this.streams.get(clientId) === res) {
          this.streams.delete(clientId);
        }
        const current = this.clients.get(clientId);
        if (current) {
          current.connected = false;
          current.lastSeen = new Date().toISOString();
        }
        this.emitStatus();
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/select') {
      const body = await readJsonBody(req);
      const clientId = String(body.clientId || '');
      const client = this.registerClient(clientId, body.name || 'Player');

      const approved = this.mode === 'open' || client.approved;
      if (client.denied || !approved) {
        sendJson(res, 403, {
          ok: false,
          error: client.denied
            ? 'This device was denied by the host.'
            : 'Waiting for host approval.'
        });
        return;
      }

      try {
        this.setCard(body.cardId, Boolean(body.selected), {
          source: 'mobile',
          ownerId: clientId
        });
        sendJson(res, 200, { ok: true, state: this.getClientState(clientId) });
      } catch (error) {
        sendJson(res, error.code === 'CARD_TAKEN' ? 409 : 400, {
          ok: false,
          code: error.code || 'SELECTION_ERROR',
          error: error.message,
          state: this.getClientState(clientId)
        });
      }
      return;
    }

    sendText(res, 404, 'Not found');
  }
}

module.exports = MobileRoom;
module.exports.isAllowedClientAddress = isAllowedClientAddress;
