import { codexStatus, startCodexLogin, pollCodexLogin, cancelCodexLogin, fetchCodexModels, saveCodexModels, disconnectCodex, codexError } from '../codex-auth.js';

/** Called only after ASAPI's loopback Origin/Host and desktop access checks. */
export async function routeCodex(req, res, path, json) {
  try {
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw codexError('CODEX_INVALID_REQUEST', 'JSON required', 415);
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 32768) throw codexError('CODEX_INVALID_REQUEST', 'Request too large', 413);
      }
      try { body = JSON.parse(text); } catch { throw codexError('CODEX_INVALID_REQUEST', 'Invalid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw codexError('CODEX_INVALID_REQUEST', 'Invalid request');
    }
    if (path === '/admin/codex/status' && req.method === 'GET') return json(res, 200, codexStatus());
    if (path === '/admin/codex/models' && req.method === 'GET') return json(res, 200, await fetchCodexModels());
    if (path === '/admin/codex/models' && req.method === 'PUT') return json(res, 200, saveCodexModels(body.models));
    if (path === '/admin/codex/connection' && req.method === 'DELETE') { disconnectCodex(); return json(res, 200, codexStatus()); }
    if (path === '/admin/codex/device-flow/start' && req.method === 'POST') return json(res, 200, await startCodexLogin());
    if (path === '/admin/codex/device-flow/poll' && req.method === 'POST') return json(res, 200, await pollCodexLogin(body.flowId));
    if (path === '/admin/codex/device-flow/cancel' && req.method === 'POST') {
      if (typeof body.flowId !== 'string' || !body.flowId) throw codexError('CODEX_INVALID_REQUEST', 'Invalid flow');
      cancelCodexLogin(body.flowId); return json(res, 200, { status: 'cancelled' });
    }
    return json(res, 404, { detail: 'CODEX_INVALID_REQUEST' });
  } catch (error) {
    const code = /^CODEX_[A-Z_]+$/.test(error.code || '') ? error.code : 'CODEX_UPSTREAM_ERROR';
    return json(res, error.status || 502, { detail: code });
  }
}
