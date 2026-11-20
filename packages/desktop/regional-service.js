export const DEFAULT_TORA_SERVICE = 'https://api.cogniticteam.com';
export const TORA_REGIONS = Object.freeze({
  china: 'https://api.cogniticteam.com.cn',
  global: DEFAULT_TORA_SERVICE,
});

export async function detectToraCountry(fetcher = fetch) {
  async function lookup(origin) {
    const response = await fetcher(origin + '/geo', {
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(2800),
    });
    if (!response.ok) throw Error('Region endpoint unavailable');
    const { country } = await response.json();
    if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country) || ['XX', 'ZZ'].includes(country)) {
      throw Error('Network region unavailable');
    }
    return country;
  }
  try { return await lookup(DEFAULT_TORA_SERVICE); }
  catch {
    try { return await Promise.any([lookup(TORA_REGIONS.china), lookup('https://geo.ohfun.online')]); }
    catch { return null; }
  }
}

/** Runs before any account state or network client is loaded. */
export async function approveToraRegion({ detect, state, save, prompt }) {
  let country = await detect();
  while (!country) {
    if (await prompt('unverified') !== 0) return null;
    country = await detect();
  }

  if (country === 'CN') {
    if (state.hideCloudflareNotice !== true && await prompt('cloudflareNotice') === 1) {
      state.hideCloudflareNotice = true;
      save(state);
    }
    if (state.acceptedMainlandTransfer !== true) {
      if (await prompt('mainlandTransfer') !== 0) return null;
      state.acceptedMainlandTransfer = true;
      save(state);
    }
  }
  if (country !== 'SG' && state.acceptedGlobalTransfer !== true) {
    if (await prompt('globalTransfer') !== 0) return null;
    state.acceptedGlobalTransfer = true;
    save(state);
  }
  const edition = country === 'CN' ? 'china' : 'global';
  return { edition, origin: TORA_REGIONS[edition] };
}
