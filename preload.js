const { contextBridge, ipcRenderer } = require('electron');

// ============================================================
// Safely load devtools-detector
// ============================================================
// Wrapped in try/catch because the library can crash ina
// Electron's isolated preload world, which would kill the
// ENTIRE preload and make window.api undefined → login fails.
// ============================================================
let devtoolsDetector = null;
try {
   
    console.log('✅ devtools-detector not loaded');
} catch (err) {
    console.error('❌ devtools-detector failed to load:', err);
}

// Expose a safe bridge to the main process
contextBridge.exposeInMainWorld('api', {
    // --- Authentication ---
    login: (username, password) => ipcRenderer.invoke('perform-login', username, password),
    getLocalAccountStatus: () => ipcRenderer.invoke('get-local-account-status'),
    createLocalAccount: (account) => ipcRenderer.invoke('create-local-account', account),
    checkSession: () => ipcRenderer.invoke('check-session'),
    logout: () => ipcRenderer.invoke('perform-logout'),

    // --- DevTools Detection (safe) ---
    startDevToolsDetection: () => {
        if (!devtoolsDetector) {
            console.warn('⚠️ devtools-detector not available — skipping.');
            return;
        }
        try {
            const { addListener, launch } = devtoolsDetector;
            addListener((isOpen) => {
                if (isOpen) {
                    ipcRenderer.send('devtools-opened');
                }
            });
            launch();
            console.log('✅ DevTools detection started');
        } catch (err) {
            console.error('❌ DevTools detection failed to start:', err);
        }
    },

    // --- Game Data ---
    getShopSettings: () => ipcRenderer.invoke('get-shop-settings'),
    getShopSetting: () => ipcRenderer.invoke('get-shop-setting'),
    updateGameTimeGap: (gapMs) => ipcRenderer.invoke('update-game-time-gap', gapMs),
    updateVoicesGame: (voiceCode) => ipcRenderer.invoke('update-voices-game', voiceCode),
    updateCommissionGame: (settings) => ipcRenderer.invoke('update-commission-game', settings),
    calculateGameCommission: (selectedCards) => ipcRenderer.invoke('calculate-game-commission', selectedCards),

    openGamePage: () => ipcRenderer.send('open-game-page'),

    // --- Balance & Sales ---
    checkBalance: () => ipcRenderer.invoke('check-balance'),
    reviewBalance: (commissionAmount) => ipcRenderer.invoke('review-balance', commissionAmount),
    registerSales: (data) => ipcRenderer.invoke('register-sales', data),
    updateSales: (data) => ipcRenderer.invoke('update-sales', data),
    getDailyIncome: (data) => ipcRenderer.invoke('get-daily-income', data),
    getShopInfo: () => ipcRenderer.invoke("get-shop-info"),
    getSalesHistory: () => ipcRenderer.invoke("get-sales-history"),
    notifyBalance: () => ipcRenderer.invoke('notify-balance'),
    reconcileBalance: () => ipcRenderer.invoke('reconcile-balance'),

    // --- Signed Device Vouchers ---
    getDeviceCode: () => ipcRenderer.invoke('get-device-code'),
    redeemCreditVoucher: (voucherCode) => ipcRenderer.invoke('redeem-credit-voucher', voucherCode),
    copyLocalText: (value) => ipcRenderer.invoke('copy-local-text', value),

    // --- First-run Device Activation ---
    getDeviceActivationStatus: () => ipcRenderer.invoke('get-device-activation-status'),
    activateDevice: (activationCode) => ipcRenderer.invoke('activate-device-license', activationCode),
    completeDeviceActivation: () => ipcRenderer.invoke('complete-device-activation'),

    // --- Mobile Cartela Room / Private Hotspot ---
    mobileRoomSetDesktopState: (state) => ipcRenderer.invoke('mobile-room-set-desktop-state', state),
    mobileRoomGetStatus: () => ipcRenderer.invoke('mobile-room-get-status'),
    mobileRoomSetAddress: (address) => ipcRenderer.invoke('mobile-room-set-address', address),
    mobileRoomRefreshAddress: () => ipcRenderer.invoke('mobile-room-refresh-address'),
    mobileRoomStart: () => ipcRenderer.invoke('mobile-room-start'),
    mobileRoomStop: () => ipcRenderer.invoke('mobile-room-stop'),
    mobileRoomApproveDevice: (clientId) => ipcRenderer.invoke('mobile-room-approve-device', clientId),
    mobileRoomDenyDevice: (clientId) => ipcRenderer.invoke('mobile-room-deny-device', clientId),
    mobileRoomSetCard: (cardId, selected) => ipcRenderer.invoke('mobile-room-set-card', cardId, selected),
    mobileRoomLockSelection: () => ipcRenderer.invoke('mobile-room-lock-selection'),
    mobileRoomNewRound: () => ipcRenderer.invoke('mobile-room-new-round'),
    privateNetworkGetStatus: () => ipcRenderer.invoke('private-network-get-status'),
    privateNetworkStart: () => ipcRenderer.invoke('private-network-start'),
    privateNetworkStop: () => ipcRenderer.invoke('private-network-stop'),
    privateNetworkOpenSettings: () => ipcRenderer.invoke('private-network-open-settings'),
    onMobileRoomStatus: (callback) => {
        const handler = (_event, status) => callback(status);
        ipcRenderer.on('mobile-room-status', handler);
        return () => ipcRenderer.removeListener('mobile-room-status', handler);
    },
    onMobileRoomCardChange: (callback) => {
        const handler = (_event, change) => callback(change);
        ipcRenderer.on('mobile-room-card-change', handler);
        return () => ipcRenderer.removeListener('mobile-room-card-change', handler);
    },

    // --- App Control ---
    quitApp: () => ipcRenderer.send('quit-app')
});
