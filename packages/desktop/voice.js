// 语音识别：GLM-ASR-2512 云端转写（智谱 open.bigmodel.cn）。
//
// 架构（v4：双通道、均免费）：
//   1) BYOK：用户配置了自己的 GLM Key（~/.cocode/voice-config.json）→ 直连
//      智谱。
//   2) 云端：未配置 Key但已登录 → 走 CoCode 免费 ASR 网关
//      /asr/v1/audio/transcriptions，用登录 token 鉴权，不计费。
//
//   · 渲染层录音（16kHz 单声道 Float32 PCM）→ IPC voice:transcribe →
//     主进程编码 WAV → multipart POST → 返回文本。
//   · 无需下载任何本地模型/引擎。
//   · 限制：文件 ≤25MB、时长 ≤30s。超长录音在编码前截断到 28s。
//
// API：POST .../audio/transcriptions
//      multipart: model=glm-asr-2512, file=<wav>
//      响应 JSON: { text, usage, ... }
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 主进程加载 core 时完成旧数据迁移，语音模块使用同一数据根。
export const COCODE_DIR = process.env.COCODE_HOME || join(homedir(), '.cocode');
export const VOICE_DIR = join(COCODE_DIR, 'voice');
const CONFIG_FILE = join(VOICE_DIR, 'voice-config.json');

const ASR_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
const COCODE_ASR_GATEWAY = 'https://cocode.ohfun.online/asr/v1';
const ASR_MODEL = 'glm-asr-2512';
// 云端上限 30s，留 2s 余量
const MAX_SECONDS = 28;
const SAMPLE_RATE = 16000;

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  if (!existsSync(VOICE_DIR)) mkdirSync(VOICE_DIR, { recursive: true });
  const next = { ...readConfig(), ...patch };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** 配置 GLM-ASR 的 API Key（初始化时写入一次）。 */
export function setAsrApiKey(key) {
  writeConfig({ glmAsrKey: String(key || '').trim() });
  return voiceStatus();
}

/**
 * 资源状态（麦克风按钮用它决定能不能录音）。
 * 云端方案 = 有自用 Key（BYOK）或已登录可走免费 CoCode ASR，二者居一即可用。
 * @param {{token?: string|null}} [opts]
 */
export function voiceStatus(opts = {}) {
  const key = readConfig().glmAsrKey ?? '';
  const ready = !!(key || opts.token);
  return {
    dir: VOICE_DIR,
    modelReady: ready,
    packagesReady: ready,
    installed: ready,
    cloud: true,
    channel: key ? 'byok' : (opts.token ? 'cloud' : 'none'),
  };
}

// ---------------------------------------------------------------- WAV 编码

/** Float32 [-1,1] PCM → 16-bit 单声道 WAV Buffer（超长截断到 MAX_SECONDS）。 */
export function encodeWav(samples) {
  const maxLen = SAMPLE_RATE * MAX_SECONDS;
  const src = samples.length > maxLen ? samples.subarray(0, maxLen) : samples;
  const dataLen = src.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);       // fmt chunk 大小
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // 单声道
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // 字节率
  buf.writeUInt16LE(2, 32);        // 块对齐
  buf.writeUInt16LE(16, 34);       // 位深
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < src.length; i++) {
    const v = Math.max(-1, Math.min(1, src[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------- 转写

/**
 * 转写 16kHz 单声道 PCM（渲染层经 IPC 送来的原始采样）。
 * 优先 BYOK（自用 Key 直连）；无 Key 时用登录 token 走免费 CoCode ASR。
 * @param {Float32Array} samples
 * @param {{token?: string|null, gatewayBase?: string}} [opts]
 * @returns {Promise<string>} 识别文本（静音/空音频返回空串）
 */
export async function transcribeSamples(samples, opts = {}) {
  const key = readConfig().glmAsrKey ?? '';
  const token = opts.token ?? '';
  if (!key && !token) {
    throw new Error('未配置 GLM-ASR API Key，且未登录 CoCode 账号（语音识别不可用）');
  }
  if (!samples || samples.length < SAMPLE_RATE * 0.2) return ''; // <0.2s 视为误触

  const wav = encodeWav(samples);
  const form = new FormData();
  form.append('model', ASR_MODEL);
  form.append('stream', 'false');
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'voice-input.wav');

  // BYOK 直连智谱；云端通道由 CoCode 网关注入上游 Key，用户无需配置。
  const endpoint = key
    ? ASR_ENDPOINT
    : `${(opts.gatewayBase || COCODE_ASR_GATEWAY).replace(/\/+$/, '')}/audio/transcriptions`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${key || token}` },
    body: form,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = JSON.parse(await res.text());
      detail = String(j?.detail?.message ?? j?.detail ?? '').slice(0, 300);
    } catch { /* ignore */ }
    throw new Error(`GLM-ASR HTTP ${res.status}：${detail}`);
  }
  const json = await res.json();
  return String(json?.text ?? '').trim();
}
