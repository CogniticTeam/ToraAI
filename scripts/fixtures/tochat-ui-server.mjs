// Real isolated ASAPI and tools with fake upstream responses, never paid calls.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveConfig, TORA_DIR } from '../../packages/core/src/config.js';
import { startASAPIServer } from '../../packages/core/src/asapi/server.js';
import { addWorkspaceRecent } from '../../packages/core/src/asapi/store.js';

assert.ok(process.env.TORA_HOME?.includes('tora-modes-additive-'), 'Use an isolated TORA_HOME');
const workspace = join(TORA_DIR, 'workspace');
mkdirSync(workspace, { recursive: true });
addWorkspaceRecent(workspace);
saveConfig({ baseURL: 'https://fixture.test/v1', apiKey: 'fixture-custom-key', model: 'fixture-vision', modelList: [{ id: 'fixture-custom', provider: 'custom', model: 'fixture-vision', baseURL: 'https://fixture.test/v1', apiKey: 'fixture-custom-key', enabled: true, vision: true }] });
const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	if (!String(url).includes('/chat/completions')) return realFetch(url, init);
	const body = JSON.parse(init.body);
	const official = String(url).includes('/tochat/v1');
	const mode = init.headers['x-tochat-mode'];
	requests.push({ official, mode, body });
	writeFileSync(join(TORA_DIR, 'requests.json'), JSON.stringify(requests));
	let delta = { content: '隔离链路已通过' };
	if (official && mode === 'work') {
		assert.ok(body.tools.some((tool) => tool.function.name === 'Write'));
		if (!body.messages.some((message) => message.role === 'tool')) {
			delta = { tool_calls: [{ index: 0, id: 'fixture-write', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: join(workspace, 'work-probe.txt'), content: 'work tool verified' }) } }] };
		} else delta = { content: '工作执行已通过' };
	} else if (official && mode === 'chat') {
		assert.ok((body.tools || []).every((tool) => ['WebSearch', 'WebFetch'].includes(tool.function.name)));
		assert.equal(body.reasoning_effort, 'max');
	}
	const content = `data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`;
	return new Response(content, { headers: { 'content-type': 'text/event-stream' } });
};
const server = await startASAPIServer({ port: Number(process.env.TORA_TOCHAT_TEST_PORT || 3218) });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
