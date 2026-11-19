# Africa Bingo Local

This is a local-only reconstruction of the supplied Africa Bingo Electron app.

## Download

Download the signed-versioned Windows x64 installer from this repository's
**Releases** page. Release binaries are not committed into the source tree.

## What changed

- Local account creation with salted `scrypt` password hashes.
- A first-run, offline, Ed25519-signed activation tied to the computer Device Code. A copied installation cannot reuse the activation on another computer.
- Account creation signs in immediately and the encrypted local session survives app restarts. Passwords remain salted `scrypt` hashes and are never saved as plaintext; explicit logout clears the remembered session.
- Local login and logout; no remote authentication.
- Device-bound, Ed25519-signed credit vouchers recorded in the SQLite deposit and anti-replay ledgers.
- An authenticated mobile cartela room for phones on the computer's private hotspot or RFC1918 LAN.
- Host approval is required for each phone, and each room uses a new random 144-bit link secret.
- Sales, balance reconciliation, history, bingo cards, and audio remain local.
- Game commission can use the six original Africa presets, a fixed percentage, an automatic per-cartela increase, or validated custom cartela-count ranges. Settings are encrypted locally and the active rate is calculated when the game starts.
- Chromium is forced into offline emulation; HTTP, HTTPS, WebSocket, secure WebSocket, and FTP requests are also canceled at the protocol layer.
- Node outbound HTTP, HTTP/2, TCP, TLS, UDP, DNS, Fetch, and WebSocket entry points are disabled before SQLite loads. The only listener is the user-started, private-address-filtered mobile cartela room.
- Chromium background networking, component updates, pings, synchronization, and DNS resolution are disabled at startup.
- Remote navigation, webviews, pop-up windows, and permission requests are denied.
- The renderer runs inside Electron's process sandbox with Node integration disabled.
- Every renderer page has a local-only Content Security Policy.
- External CDN scripts and styles were removed from the renderer pages.
- Server-era heartbeat, deposit/sales sync, pending-sync, and update-message IPC surfaces were removed.
- Runtime dependencies were pruned to Electron, SQLite, and SQLite's two local loader modules; installer/download/proxy helpers are not shipped.
- The mutable profile is portable and stored beside the executable in `africa-bingo-local-data`.

## Run the prepared Windows app

Open the sibling `Africa Bingo Local` folder and launch `Africa Bingo Local.exe`.

On the first local-only launch, copy the activation request and send it to the license owner. Africa displays the World-license-compatible software identity as `SW-` followed by eight groups of four hexadecimal characters. The owner creates the signed `HB1` code with the existing HomeMade Bingo license library; no internet connection is involved. The code works only with the Device Code shown by that computer. Older unprefixed activation codes remain supported.

After activation, create a username and password. The new account is signed in immediately and remains signed in across restarts until **Logout** is selected. New shops start at zero credit. Release builds never include a customer database, activation, account, balance, or sales history.

To add new credit, open **Redeem Credit Voucher**, send the displayed device code to the authorized voucher provider, then paste the signed `HBV1` or `ABV1` code. The signing private key stays with the provider and is not included in this app. A voucher is valid only for its intended computer and can be redeemed only once.

To collect cartela numbers by phone, open **Mobile Cartela Room**. On Windows, start the private hotspot (or use an existing private LAN), start the room, share the QR/link, and explicitly approve each phone. Starting a game locks mobile selection; **New Game** opens a fresh round.

## Local data

The portable database is:

`africa-bingo-local-data/database/local.db`

Back up the entire `africa-bingo-local-data` folder to preserve accounts, credits, settings, and sales history.

## Verification

Run:

```powershell
node --check main.js
node tests/license-service.js
node tests/commission-settings.js
node tests/offline-audit.js
node tests/voucher-service.js
node tests/mobile-room.js
node tests/guarded-mobile-room.js
node tests/local-flow.js
```

The supplied Windows Electron runtime is reused, but the prepared folder contains only the rebuilt `resources/app` payload. Your untouched `Africa Bingo Offline` folder remains the recovery copy.

## Build a Windows installer

The `Windows release` GitHub Actions workflow runs the complete local-only test
suite on Windows and builds an NSIS installer. Pushing a version tag such as
`v4.1.0` publishes the resulting `.exe` on GitHub Releases automatically.
