document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('mobileRoomModal');
  const message = document.getElementById('mobileRoomMessage');
  const addressSelect = document.getElementById('networkAddress');
  const roomQr = document.getElementById('roomQr');
  let latestStatus = null;
  let renderedQrUrl = '';

  function showMessage(text, success = false) {
    message.textContent = text || '';
    message.className = success ? 'message success' : 'message';
  }

  function renderQr(url) {
    if (url === renderedQrUrl) return;
    renderedQrUrl = url || '';
    roomQr.replaceChildren();
    if (!url || typeof QRCode !== 'function') return;
    new QRCode(roomQr, {
      text: url,
      width: 160,
      height: 160,
      colorDark: '#111111',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  function renderAddresses(status) {
    const selected = status.preferredAddress || 'auto';
    addressSelect.replaceChildren();
    const automatic = document.createElement('option');
    automatic.value = 'auto';
    automatic.textContent = 'Automatic (recommended)';
    addressSelect.appendChild(automatic);

    for (const item of status.networkAddresses || []) {
      const option = document.createElement('option');
      option.value = item.address;
      option.textContent = `${item.address} — ${item.interfaceName}`;
      addressSelect.appendChild(option);
    }
    addressSelect.value = selected;
  }

  function renderClients(clients) {
    const container = document.getElementById('mobileClients');
    container.replaceChildren();

    if (!clients?.length) {
      const empty = document.createElement('p');
      empty.className = 'room-line';
      empty.textContent = 'No phones connected.';
      container.appendChild(empty);
      return;
    }

    for (const client of clients) {
      const row = document.createElement('div');
      row.className = 'client';
      const name = document.createElement('div');
      name.className = 'client-name';
      const access = client.denied ? 'Denied' : (client.approved ? 'Approved' : 'Waiting');
      name.textContent = `${client.name} · ${access} · ${client.selectedCartelaCount || 0} cartela(s)`;
      row.appendChild(name);

      if (!client.approved || client.denied) {
        const approve = document.createElement('button');
        approve.className = 'approve';
        approve.textContent = 'Approve';
        approve.addEventListener('click', async () => {
          await window.api.mobileRoomApproveDevice(client.id);
        });
        row.appendChild(approve);
      }

      if (!client.denied) {
        const deny = document.createElement('button');
        deny.className = 'deny';
        deny.textContent = 'Deny';
        deny.addEventListener('click', async () => {
          await window.api.mobileRoomDenyDevice(client.id);
        });
        row.appendChild(deny);
      }
      container.appendChild(row);
    }
  }

  function renderRoom(status) {
    latestStatus = status;
    const missingPrivateAddress = status.running && status.address === '127.0.0.1';
    document.getElementById('roomStatus').textContent = missingPrivateAddress
      ? 'Room started, but no private hotspot/LAN address was found. Start the hotspot, then refresh addresses.'
      : status.running
        ? `Room running · code ${status.roomCode} · ${status.connectedCount || 0} phone(s)`
        : 'Room stopped';
    document.getElementById('roomUrl').textContent = status.connectUrl || '';
    const selected = status.selectedCards || [];
    document.getElementById('mobileSelectedCards').textContent = selected.length
      ? `${selected.length}: ${selected.join(', ')}`
      : 'None';
    document.getElementById('startRoomBtn').disabled = Boolean(status.running);
    document.getElementById('stopRoomBtn').disabled = !status.running;
    document.getElementById('copyRoomUrlBtn').disabled = !status.connectUrl || missingPrivateAddress;
    renderAddresses(status);
    renderClients(status.clients || []);
    renderQr(missingPrivateAddress ? '' : status.connectUrl);
  }

  async function refreshHotspot() {
    const status = await window.api.privateNetworkGetStatus();
    const statusText = status.supported
      ? (status.running ? 'Windows Mobile Hotspot is running.' : `Windows Mobile Hotspot: ${status.state || 'off'}.`)
      : (status.message || 'Automatic hotspot control is available in the Windows build.');
    document.getElementById('hotspotStatus').textContent = statusText;
    document.getElementById('hotspotCredentials').textContent = status.running
      ? `Wi-Fi: ${status.ssid || 'configured hotspot'} · Password: ${status.password || 'see Windows settings'}`
      : '';
    document.getElementById('startHotspotBtn').disabled = !status.supported || status.running;
    document.getElementById('stopHotspotBtn').disabled = !status.supported || !status.running;
    document.getElementById('openHotspotSettingsBtn').hidden = status.platform !== 'win32';
  }

  async function refreshRoom() {
    renderRoom(await window.api.mobileRoomGetStatus());
  }

  document.getElementById('mobileRoomBtn').addEventListener('click', async () => {
    modal.classList.add('open');
    showMessage('');
    await Promise.all([refreshRoom(), refreshHotspot()]);
  });

  document.getElementById('closeMobileRoomBtn').addEventListener('click', () => {
    modal.classList.remove('open');
  });

  document.getElementById('startHotspotBtn').addEventListener('click', async () => {
    showMessage('Starting Windows Mobile Hotspot…', true);
    const result = await window.api.privateNetworkStart();
    if (!result.success) showMessage(result.error || 'Could not start the hotspot.');
    else showMessage('Private hotspot started.', true);
    await Promise.all([refreshHotspot(), refreshRoom()]);
  });

  document.getElementById('stopHotspotBtn').addEventListener('click', async () => {
    const result = await window.api.privateNetworkStop();
    if (!result.success) showMessage(result.error || 'Could not stop the hotspot.');
    else showMessage('Private hotspot stopped.', true);
    await Promise.all([refreshHotspot(), refreshRoom()]);
  });

  document.getElementById('openHotspotSettingsBtn').addEventListener('click', async () => {
    const result = await window.api.privateNetworkOpenSettings();
    if (!result.success) showMessage(result.error || 'Could not open Windows Hotspot settings.');
  });

  document.getElementById('refreshNetworkBtn').addEventListener('click', async () => {
    renderRoom(await window.api.mobileRoomRefreshAddress());
  });

  addressSelect.addEventListener('change', async () => {
    renderRoom(await window.api.mobileRoomSetAddress(addressSelect.value));
  });

  document.getElementById('startRoomBtn').addEventListener('click', async () => {
    showMessage('Starting the local cartela room…', true);
    try {
      await window.api.mobileRoomSetDesktopState({
        totalCards: 150,
        selectedCards: latestStatus?.selectedCards || [],
        cartelaType: 'africa',
        cartelaLabel: 'Africa Bingo Cartela'
      });
      const status = await window.api.mobileRoomStart();
      renderRoom(status);
      if (status.address === '127.0.0.1') {
        showMessage('Room started, but a private hotspot/LAN address is required before phones can connect.');
      } else {
        showMessage('Room started. Connect a phone, open the player link, then approve the device.', true);
      }
    } catch (error) {
      showMessage(error.message || 'Could not start the room.');
    }
  });

  document.getElementById('stopRoomBtn').addEventListener('click', async () => {
    renderRoom(await window.api.mobileRoomStop());
    showMessage('Room stopped. Existing cartela selections were kept.', true);
  });

  document.getElementById('copyRoomUrlBtn').addEventListener('click', async () => {
    if (!latestStatus?.connectUrl) return;
    await window.api.copyLocalText(latestStatus.connectUrl);
    showMessage('Player link copied.', true);
  });

  window.api.onMobileRoomStatus(renderRoom);
});
