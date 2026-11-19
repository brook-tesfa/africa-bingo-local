'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { fork } = require('node:child_process');

if (process.argv.includes('--guarded-child')) {
  const deny = () => {
    const error = new Error('Outbound network disabled for test.');
    error.code = 'ERR_AFRICA_BINGO_NETWORK_DISABLED';
    throw error;
  };

  const https = require('node:https');
  const http2 = require('node:http2');
  const net = require('node:net');
  const tls = require('node:tls');
  const dns = require('node:dns');
  const dgram = require('node:dgram');

  http.request = deny;
  http.get = deny;
  https.request = deny;
  https.get = deny;
  http2.connect = deny;
  net.connect = deny;
  net.createConnection = deny;
  net.Socket.prototype.connect = deny;
  tls.connect = deny;
  dgram.createSocket = deny;
  dns.lookup = deny;
  if (dns.promises) dns.promises.lookup = deny;
  globalThis.fetch = deny;

  const MobileRoom = require('../mobile-room');
  const room = new MobileRoom({ assetsDir: path.join(__dirname, '..', 'mobile') });

  room.start({
    mode: 'approval',
    totalCards: 150,
    selectedCards: [],
    cartelaType: 'africa',
    cartelaLabel: 'Africa Bingo Cartela'
  }).then(status => {
    process.send?.({ type: 'ready', port: status.port });
  }).catch(error => {
    process.send?.({ type: 'error', message: error.stack || error.message });
    process.exitCode = 1;
  });

  process.on('message', async message => {
    if (message === 'stop') {
      await room.stop();
      process.exit(0);
    }
  });
} else {
  function requestJoinPage(port) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: '/join' }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          text: Buffer.concat(chunks).toString('utf8')
        }));
      }).on('error', reject);
    });
  }

  async function main() {
    const child = fork(__filename, ['--guarded-child'], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });

    try {
      const ready = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Guarded room startup timed out.')), 10000);
        child.once('error', reject);
        child.on('message', message => {
          if (message?.type === 'ready') {
            clearTimeout(timeout);
            resolve(message);
          } else if (message?.type === 'error') {
            clearTimeout(timeout);
            reject(new Error(message.message));
          }
        });
      });

      const page = await requestJoinPage(ready.port);
      assert.equal(page.statusCode, 200);
      assert.match(page.text, /Africa Bingo Local/);
      console.log('guarded mobile room passed (listener works while every outbound entry point is denied)');
    } finally {
      if (child.connected) child.send('stop');
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }

  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
