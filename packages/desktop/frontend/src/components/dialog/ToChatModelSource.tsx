import { useEffect } from 'react';

import { TOCHAT_SOURCE_EVENT, TOCHAT_SOURCE_KEY } from '@/lib/applicationModes';

/** Built-in ToChat models are no longer offered. New sessions stay on custom models. */
export function ToChatModelSource() {
	useEffect(() => {
		if (localStorage.getItem(TOCHAT_SOURCE_KEY) === 'custom') return;
		localStorage.setItem(TOCHAT_SOURCE_KEY, 'custom');
		window.dispatchEvent(new Event(TOCHAT_SOURCE_EVENT));
	}, []);
	return null;
}
