import type { ContentBlock } from '@agentscope-ai/agentscope/message';
import mime from 'mime';

import {DOUBAO_MODEL_ID,DOUBAO_INPUT_TYPES,IMAGE_MIME_TYPES,normalizeMediaType,mediaInputPart} from '../../../../core/src/chat-media.js';

export const chatAttachmentTypes = (model: string, mode = 'chat') => model === 'glm-5.3' ? [] : model === DOUBAO_MODEL_ID && ['chat','work'].includes(mode) ? DOUBAO_INPUT_TYPES.filter(type => type !== 'text') : IMAGE_MIME_TYPES;

export async function processChatAttachment(file: File, model: string, mode: string, imageLimit = 32 * 1024 * 1024): Promise<ContentBlock> {
  const type = normalizeMediaType(file.type || mime.getType(file.name) || '');
  const limit = type.startsWith('audio/') ? 10 * 1024 * 1024 : type.startsWith('video/') ? 20 * 1024 * 1024 : imageLimit;
  if (!file.size || file.size > limit || !chatAttachmentTypes(model, mode).map(normalizeMediaType).includes(type)) throw Error('unsupported-media');
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return {id:crypto.randomUUID(),type:'data',source:{type:'base64',media_type:type,data:url.split(',')[1]},name:file.name,created_at:new Date().toISOString()};
}

export function attachmentWirePart(item: ContentBlock) {
  if (item.type !== 'data') return null;
  const url = item.source.type === 'base64' ? `data:${item.source.media_type};base64,${item.source.data}` : item.source.url;
  return mediaInputPart(url, item.source.media_type);
}
