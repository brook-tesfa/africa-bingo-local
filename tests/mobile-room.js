'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const MobileRoom = require('../mobile-room');
const { isAllowedClientAddress } = require('../mobile-room');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      } : undefined
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode,
          text,
          json: response.headers['content-type']?.includes('application/json')
            ? JSON.parse(text)
            : null
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  assert.equal(isAllowedClientAddress('127.0.0.1'), true);
  assert.equal(isAllowedClientAddress('::ffff:192.168.137.22'), true);
  assert.equal(isAllowedClientAddress('10.20.30.40'), true);
  assert.equal(isAllowedClientAddress('172.31.1.9'), true);
  assert.equal(isAllowedClientAddress('8.8.8.8'), false);
  assert.equal(isAllowedClientAddress('2001:4860:4860::8888'), false);

  const room = new MobileRoom({ assetsDir: path.join(__dirname, '..', 'mobile') });
  try {
    const status = await room.start({
      mode: 'approval',
      totalCards: 150,
      selectedCards: [2],
      cartelaType: 'africa',
      cartelaLabel: 'Africa Bingo Cartela'
    });
    assert.equal(status.running, true);
    assert.equal(status.selectedCards.includes(2), true);
    assert.match(status.connectUrl, /^http:\/\/(?:127\.0\.0\.1|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/);

    const session = new URL(status.connectUrl).searchParams.get('session');
    const joinPage = await request(status.port, `/join?session=${encodeURIComponent(session)}`);
    assert.equal(joinPage.statusCode, 200);
    assert.match(joinPage.text, /Africa Bingo Local/);

    const firstState = await request(
      status.port,
      `/api/state?session=${encodeURIComponent(session)}&clientId=phone-one&name=Player%20One`
    );
    assert.equal(firstState.statusCode, 200);
    assert.equal(firstState.json.state.approved, false);
    room.approveClient('phone-one');

    const selected = await request(status.port, `/api/select?session=${encodeURIComponent(session)}`, {
      method: 'POST',
      body: { clientId: 'phone-one', name: 'Player One', cardId: 25, selected: true }
    });
    assert.equal(selected.statusCode, 200);
    assert.equal(selected.json.state.mySelectedCards.includes(25), true);

    await request(
      status.port,
      `/api/state?session=${encodeURIComponent(session)}&clientId=phone-two&name=Player%20Two`
    );
    room.approveClient('phone-two');
    const conflict = await request(status.port, `/api/select?session=${encodeURIComponent(session)}`, {
      method: 'POST',
      body: { clientId: 'phone-two', name: 'Player Two', cardId: 25, selected: true }
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json.code, 'CARD_TAKEN');

    room.lockSelection();
    const locked = await request(status.port, `/api/select?session=${encodeURIComponent(session)}`, {
      method: 'POST',
      body: { clientId: 'phone-one', name: 'Player One', cardId: 26, selected: true }
    });
    assert.equal(locked.statusCode, 400);
    assert.equal(locked.json.code, 'SELECTION_LOCKED');

    const badSession = await request(status.port, '/api/state?session=wrong');
    assert.equal(badSession.statusCode, 403);

    console.log('mobile room passed (private filter, session secret, approval, ownership, lock)');
  } finally {
    await room.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
