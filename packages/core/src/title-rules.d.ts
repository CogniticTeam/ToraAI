export const DEFAULT_TITLE: string;
export const TITLE_PROMPT: string;
export const TITLE_LANGUAGES: Readonly<Record<string,string>>;
export function normalizeTitleLanguage(value: unknown): string | null;
export function placeholderTitle(text: unknown): string;
export function sanitizeTitle(text: unknown, language?: unknown): string;
export function titleMessages(input: {userText: unknown; assistantText?: unknown; language?: unknown}): {role: string; content: string}[];
