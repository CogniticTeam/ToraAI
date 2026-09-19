import { client } from './client';

export type AutomationAction =
	| { type: 'command'; command: string; timeout?: number }
	| { type: 'checkpoint' }
	| { type: 'notify'; message: string };

export interface Automation {
	id: string;
	name: string;
	enabled: boolean;
	event: string;
	matcher: string;
	actions: AutomationAction[];
	created_at?: string;
}

export interface Notification {
	id: string;
	message: string;
	at: number;
}

export const automationsApi = {
	list: () => client.get<{ automations: Automation[] }>('/automations', {}, { silent: true }),

	create: (rule: Partial<Automation>) => client.post<Automation>('/automations', rule),

	update: (id: string, patch: Partial<Automation>) =>
		client.patch<Automation>(`/automations/${id}`, patch),

	remove: (id: string) => client.delete<{ status: string }>(`/automations/${id}`),

	notifications: (sessionId: string) =>
		client.get<{ notifications: Notification[] }>(`/sessions/${sessionId}/notifications`, {}, { silent: true }),
};
