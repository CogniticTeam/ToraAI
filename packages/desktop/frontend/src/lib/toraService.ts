type RegionalService = { edition: 'china' | 'global' | null; origin: string };
type ServiceBridge = { getAccountService?: () => RegionalService | null };

const bridge = typeof window === 'undefined' ? undefined : (window as Window & { toraWindow?: ServiceBridge }).toraWindow;
const regional = bridge?.getAccountService?.();
export const toraEdition = regional?.edition === 'china' ? '中国版' : regional?.edition === 'global' ? '海外版' : null;

export function authBaseURL() {
	return regional?.edition
		? regional.origin
		: (localStorage.getItem('tora_auth_api') || 'https://api.cogniticteam.com').replace(/\/+$/, '');
}
