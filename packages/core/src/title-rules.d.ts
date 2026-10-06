export const DEFAULT_TITLE: string;
export const TITLE_PROMPT: string;
export function placeholderTitle(text: unknown): string;
export function sanitizeTitle(text: unknown): string;
export function titleMessages(input: {userText: unknown; assistantText?: unknown}): {role: string; content: string}[];
