// Run before theme/i18n/app modules. Copy preferences without deleting old keys,
// so an older installed version can still read its state after a rollback.
(() => {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(Boolean);
    for (const key of keys) {
      if (!/^cocode(?:[._:-]|$)/.test(key)) continue;
      const target = key.replace(/^cocode/, 'tora');
      if (localStorage.getItem(target) !== null) continue;
      let value = localStorage.getItem(key);
      if (value === null) continue;
      if (target === 'tora_auth_api' && /^https:\/\/cocode\.ohfun\.online\/?$/.test(value)) {
        value = 'https://tora.ohfun.online';
      }
      localStorage.setItem(target, value);
    }
  } catch {
    // Restricted storage must not prevent startup; original data remains intact.
  }
})();
