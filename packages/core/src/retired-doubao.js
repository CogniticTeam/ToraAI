const identifiers = /(?:^|[/_\s-])(?:doubao|seedream|seedance)(?=$|[-_.\d\s])|^(?:volcengine|byteplus)$|豆包/i;
const providerDomains = ['volces.com', 'volcengine.com', 'bytepluses.com', 'byteplus.com'];

export function isRetiredDoubao(...identifiersOrEndpoints) {
  return identifiersOrEndpoints.some(value => {
    if (typeof value !== 'string') return false;
    if (identifiers.test(value)) return true;
    try {
      const { hostname } = new URL(value);
      return providerDomains.some(domain => hostname === domain || hostname.endsWith('.' + domain));
    } catch {
      return false;
    }
  });
}
