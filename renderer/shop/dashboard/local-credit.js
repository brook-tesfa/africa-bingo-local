document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('creditModal');
  const voucherInput = document.getElementById('voucherCode');
  const message = document.getElementById('creditMessage');
  const currentBalance = document.getElementById('currentBalance');
  const deviceCode = document.getElementById('deviceCode');
  const redeemButton = document.getElementById('redeemVoucherBtn');

  async function refreshBalance() {
    const info = await window.api.getShopInfo();
    currentBalance.textContent = info?.status === 'success'
      ? `Current balance: ${Number(info.current_balance).toFixed(2)} ETB`
      : 'Current balance unavailable';
  }

  async function refreshDeviceCode() {
    const result = await window.api.getDeviceCode();
    deviceCode.value = result?.success ? result.device_code : 'Unavailable';
  }

  document.getElementById('creditBtn').addEventListener('click', async () => {
    message.textContent = '';
    message.className = 'message';
    voucherInput.value = '';
    modal.classList.add('open');
    await Promise.all([refreshBalance(), refreshDeviceCode()]);
    voucherInput.focus();
  });

  document.getElementById('cancelCreditBtn').addEventListener('click', () => {
    modal.classList.remove('open');
  });

  document.getElementById('copyDeviceCodeBtn').addEventListener('click', async () => {
    await window.api.copyLocalText(deviceCode.value);
    message.className = 'message success';
    message.textContent = 'Device code copied.';
  });

  redeemButton.addEventListener('click', async () => {
    const voucherCode = voucherInput.value.trim();
    if (!voucherCode) {
      message.className = 'message';
      message.textContent = 'Paste the signed voucher code first.';
      return;
    }

    redeemButton.disabled = true;
    message.className = 'message success';
    message.textContent = 'Verifying device signature and voucher…';
    try {
      const result = await window.api.redeemCreditVoucher(voucherCode);
      if (!result?.success) throw new Error(result?.message || 'Voucher redemption failed.');
      message.textContent = `Added ${Number(result.amount).toFixed(2)} ETB. New balance: ${Number(result.balance).toFixed(2)} ETB.`;
      voucherInput.value = '';
      await refreshBalance();
    } catch (error) {
      message.className = 'message';
      message.textContent = error.message;
    } finally {
      redeemButton.disabled = false;
    }
  });
});
