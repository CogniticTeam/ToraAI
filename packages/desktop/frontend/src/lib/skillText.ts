import i18n from '@/i18n';

/**
 * SkillHub ships two blurbs per skill: `description` (often English) and
 * `description_zh`. Neither is guaranteed — some skills only have one, and a
 * few have the same string in both slots.
 *
 * Pick the one matching the current UI language, then fall back to whatever
 * exists so a card never renders an empty line.
 */
export function skillDescription(skill: {
	description?: string | null;
	description_zh?: string | null;
}): string {
	const en = (skill.description ?? '').trim();
	const zh = (skill.description_zh ?? '').trim();

	const lang = typeof i18n?.language === 'string' ? i18n.language : 'en';
	const prefersZh = lang.toLowerCase().startsWith('zh');

	return prefersZh ? zh || en : en || zh;
}

/**
 * Human label for a hub category id.
 *
 * Hubs publish categories as kebab-case English ids (`office-efficiency`,
 * `rag-knowledge`). Prefer a translation; when one is missing — a hub adds a
 * category we have not translated yet — fall back to title-casing the id so the
 * chip is still readable rather than showing a raw slug or an i18n key.
 */
export function categoryLabel(id: string): string {
	const key = `skill.category.${id}`;
	const translated = i18n.t(key, { defaultValue: '' });
	if (typeof translated === 'string' && translated && translated !== key) return translated;
	return id
		.replace(/[-_]+/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase());
}
