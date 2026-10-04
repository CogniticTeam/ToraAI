export const RELEASES_API = 'https://api.github.com/repos/CogniticTeam/ToraAI/releases';
export const RELEASES_PAGE = 'https://github.com/CogniticTeam/ToraAI/releases';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const releaseVersion = value => {
  const version = String(value ?? '').replace(/^v/i, '');
  return VERSION.test(version) ? version : null;
};
export const releasePage = (version, tag = `v${version}`) => `${RELEASES_PAGE}/tag/${encodeURIComponent(tag)}`;

/** The updater feed supplies HTML, whereas GitHub's REST body is Markdown. */
export function updaterNotes(info = {}) {
  const notes = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.find(item => releaseVersion(item?.version) === releaseVersion(info.version))?.note
    : info.releaseNotes;
  if (typeof notes !== 'string') return '';
  return notes.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ').replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim().slice(0, 100_000);
}

/** Injected storage/network keep update policy independent of release-note availability. */
export function createReleaseNotesService({ currentVersion, fetchRelease, readState = () => ({}), writeState = () => {} }) {
  let state;
  let latestRequestedUpdate = null;
  const pending = new Map();
  function saved() {
    if (!state) {
      try { state = readState(); } catch { /* A missing cache is normal on first launch. */ }
      if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
    }
    return state;
  }
  function persist() { try { writeState(saved()); } catch { /* Cache failure never stops the updater. */ } }
  const validCache = (value, version) => value?.version === version &&
    ['ready', 'empty'].includes(value.status) && typeof value.notes === 'string' &&
    value.notes.length <= 100_000 && [releasePage(version), releasePage(version, version)].includes(value.url);
  function remember(version, result) {
    const current = currentVersion();
    const installed = version === current ? result : saved().releases?.[current];
    const update = version === latestRequestedUpdate ? result : saved().releases?.[latestRequestedUpdate];
    // Keep the installed version and most recently requested update available offline.
    // Completion order must not let a slow installed-version request erase newer notes.
    saved().releases = { ...(validCache(installed, current) ? { [current]: installed } : {}),
      ...(validCache(update, latestRequestedUpdate) ? { [latestRequestedUpdate]: update } : {}) };
    persist();
    return result;
  }

  function prime(info = {}) {
    const version = releaseVersion(info.version), notes = updaterNotes(info);
    if (!version || !notes) return null;
    if (version !== currentVersion()) latestRequestedUpdate = version;
    const cached = saved().releases?.[version];
    if (validCache(cached, version)) return cached;
    return remember(version, { version, title: `Tora ${version}`, notes, url: releasePage(version), status: 'ready' });
  }

  async function get(versionValue, info = {}, { refresh = false } = {}) {
    const version = releaseVersion(versionValue);
    if (!version) return null;
    if (version !== currentVersion()) latestRequestedUpdate = version;
    const cached = saved().releases?.[version];
    if (!refresh && validCache(cached, version)) return cached;
    if (pending.has(version)) return pending.get(version);
    const request = (async () => {
      try {
        let response = await fetchRelease(`${RELEASES_API}/tags/v${encodeURIComponent(version)}`);
        // Both v1.2.3 and 1.2.3 tags are supported; never substitute the latest release.
        if (response.status === 404) response = await fetchRelease(`${RELEASES_API}/tags/${encodeURIComponent(version)}`);
        if (!response.ok) throw Error('Release unavailable');
        const release = await response.json();
        if (release.draft || releaseVersion(release.tag_name) !== version) throw Error('Release version mismatch');
        const notes = typeof release.body === 'string' ? release.body.trim().slice(0, 100_000) : '';
        const result = { version, title: typeof release.name === 'string' ? release.name.slice(0, 300) : `Tora ${version}`,
          notes, url: releasePage(version, release.tag_name), status: notes ? 'ready' : 'empty' };
        return remember(version, result);
      } catch {
        const notes = updaterNotes({ ...info, version });
        const result = { version, title: `Tora ${version}`, notes, url: releasePage(version), status: notes ? 'ready' : 'error' };
        return notes ? remember(version, result) : result;
      }
    })();
    pending.set(version, request);
    try { return await request; } finally { pending.delete(version); }
  }

  async function installed() {
    const version = releaseVersion(currentVersion());
    if (!version || saved().seenVersion === version) return null;
    const result = await get(version);
    // A failure stays pending for the next launch without interrupting startup.
    return result?.status === 'error' || saved().seenVersion === version ? null : result;
  }
  function acknowledge(version) {
    if (version !== currentVersion()) return false;
    saved().seenVersion = version;
    persist();
    return true;
  }
  return { get, prime, installed, acknowledge };
}
