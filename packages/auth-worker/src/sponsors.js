// 爱发电开放 API 只能由 Worker 调用。绝不向客户端返回 Token、签名或原始订单。
const AFDIAN_SPONSORS_URL = 'https://afdian.com/api/open/query-sponsor';
const CACHE_TTL_MS = 5 * 60 * 1000;
const pageCache = new Map();
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function shanghaiMonthBounds(now = Date.now()) {
  const local = new Date(now + SHANGHAI_OFFSET_MS);
  const year = local.getUTCFullYear();
  const monthIndex = local.getUTCMonth();
  return {
    month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
    startSeconds: (Date.UTC(year, monthIndex, 1) - SHANGHAI_OFFSET_MS) / 1000,
    endSeconds: (Date.UTC(year, monthIndex + 1, 1) - SHANGHAI_OFFSET_MS) / 1000,
  };
}

export class SponsorQueryFailure extends Error {
  constructor(code) { super('赞助者服务暂不可用'); this.name = 'SponsorQueryFailure'; this.code = code; }
}

export async function signSponsorQuery(userId, token, page, timestamp, digest = (data) => crypto.subtle.digest('MD5', data)) {
  const params = JSON.stringify({ page });
  const source = `${token}params${params}ts${timestamp}user_id${userId}`;
  const bytes = new Uint8Array(await digest(new TextEncoder().encode(source)));
  const sign = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return { user_id: userId, params, ts: timestamp, sign };
}

export async function querySponsorPage(env, page, options = {}) {
  const userId = String(env.AFD_USER_ID || '').trim();
  const token = String(env.AFD_TOKEN || '').trim();
  if (!userId || !token) throw new SponsorQueryFailure('not_configured');
  if (userId.length !== 32) throw new SponsorQueryFailure('invalid_user_id_length');
  const now = options.now ?? Date.now();
  const period = shanghaiMonthBounds(now);
  const cacheKey = `${userId}:${period.month}:${page}`;
  if (!options.fetcher) {
    const cached = pageCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
  }

  const payload = await signSponsorQuery(userId, token, page, Math.floor(now / 1000), options.digest);
  const response = await (options.fetcher || fetch)(AFDIAN_SPONSORS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new SponsorQueryFailure(`upstream_http_${response.status}`);
  const body = await response.json();
  if (body?.ec !== 200) throw new SponsorQueryFailure(`upstream_ec_${Number(body?.ec) || 'unknown'}`);
  if (!Array.isArray(body?.data?.list)) throw new SponsorQueryFailure('unexpected_response');
  const totalPage = Number(body.data.total_page) || 1;
  const value = {
    page,
    month: period.month,
    hasMore: page < totalPage,
    supporters: body.data.list
      .filter(item => {
        const lastPayTime = Number(item?.last_pay_time);
        return Number.isFinite(lastPayTime) && lastPayTime >= period.startSeconds && lastPayTime < period.endSeconds;
      })
      .map(item => ({ name: typeof item?.user?.name === 'string' ? item.user.name.trim().slice(0, 80) : '' }))
      .filter(item => item.name),
  };
  if (!options.fetcher) {
    if (pageCache.size >= 50) pageCache.clear();
    pageCache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS });
  }
  return value;
}
