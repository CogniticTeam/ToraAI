import { useEffect, useState } from 'react';

import { hubApi } from '@/api';
import type { HubCategory } from '@/api';

/**
 * The category taxonomy of one skill hub.
 *
 * Unlike cards this is not paginated and not searchable — a hub either has a
 * fixed taxonomy (SkillHub's 9 top-level categories) or one derived from a
 * catalog page (OpenAgentSkill). A failure is swallowed into an empty list:
 * categories are a browsing aid, and losing them must not take the whole
 * panel down with them.
 *
 * @param hubId - Hub to ask, or `null` when the "mine" tab is selected.
 */
export function useHubCategories(hubId: string | null) {
	const [categories, setCategories] = useState<HubCategory[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!hubId) {
			setCategories([]);
			return;
		}
		let cancelled = false;
		setLoading(true);
		hubApi.skill
			.listCategories(hubId)
			.then((list) => {
				if (!cancelled) setCategories(list);
			})
			.catch(() => {
				if (!cancelled) setCategories([]);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [hubId]);

	return { categories, loading };
}
