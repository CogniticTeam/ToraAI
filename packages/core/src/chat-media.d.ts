export const DOUBAO_MODEL_ID: 'doubao-seed-2-1-lite-260915';
export const IMAGE_MIME_TYPES: string[];
export const AUDIO_MIME_TYPES: string[];
export const VIDEO_MIME_TYPES: string[];
export const DOUBAO_INPUT_TYPES: string[];
export function normalizeMediaType(type: string): string;
export function mediaInputPart(url: string, type?: string): {type: string; image_url?: {url: string}; audio_url?: string; video_url?: string; fps?: number};
