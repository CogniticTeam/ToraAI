// Public metadata and wire helpers; never carries an upstream credential.
export const DOUBAO_MODEL_ID = 'doubao-seed-2-1-lite-260915';
export const IMAGE_MIME_TYPES = ['image/jpeg','image/png','image/webp','image/gif'];
export const AUDIO_MIME_TYPES = ['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/flac','audio/x-flac','audio/aac','audio/mp4','audio/x-m4a'];
export const VIDEO_MIME_TYPES = ['video/mp4','video/quicktime','video/mov','video/x-msvideo'];
export const DOUBAO_INPUT_TYPES = ['text',...IMAGE_MIME_TYPES,...AUDIO_MIME_TYPES,...VIDEO_MIME_TYPES];
export const normalizeMediaType = type => ({'audio/mpeg':'audio/mp3','audio/x-wav':'audio/wav','audio/x-flac':'audio/flac','audio/x-m4a':'audio/mp4','video/quicktime':'video/mov'})[type] || type;
export function mediaInputPart(url, type = '') {
  const mime = type || url?.match(/^data:([^;,]+)/)?.[1] || 'image/png';
  if (mime.startsWith('audio/')) return {type:'input_audio',audio_url:url.replace(/^data:[^;,]+/, 'data:'+normalizeMediaType(mime))};
  if (mime.startsWith('video/')) return {type:'input_video',video_url:url.replace(/^data:[^;,]+/, 'data:'+normalizeMediaType(mime)),fps:1};
  return {type:'image_url',image_url:{url}};
}
