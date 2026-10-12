import type {PanelKey} from '@/components/panel/PanelDock';

const knownPanels = new Set<PanelKey>(['plan','mcp','skill','permission','knowledge','team','checkpoint','diff','hooks','browser','terminal']);

/** Migrate old columns to one ordered, unique tool-tab list. */
export function normalizePanelLayout(value: unknown): PanelKey[][] {
	if (!Array.isArray(value)) return [];
	const keys = [...new Set(value.flat().filter((key): key is PanelKey => typeof key === 'string' && knownPanels.has(key as PanelKey)))];
	return keys.length ? [['browser',...keys.filter(key=>key!=='browser')]] : [];
}

export function openPanelInLayout(layout: PanelKey[][], key: PanelKey): PanelKey[][] {
	return normalizePanelLayout([...layout, [key]]);
}

export function closePanelInLayout(layout: PanelKey[][], key: PanelKey): PanelKey[][] {
	return normalizePanelLayout(layout.map(column => column.filter(value => value !== key)));
}

/** Closing the active tab selects its neighbour; other closes preserve selection. */
export function nextPanelAfterClose(keys: PanelKey[], active: PanelKey | null, closed: PanelKey): PanelKey | null {
	if (closed !== active) return active;
	const index = keys.indexOf(closed);
	return keys[index + 1] ?? keys[index - 1] ?? null;
}
