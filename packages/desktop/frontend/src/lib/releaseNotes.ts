export type ReleaseNotes = {
	version: string;
	title?: string;
	notes: string;
	url: string;
	status: 'loading' | 'ready' | 'empty' | 'error';
};
export type ReleaseNotesBridge = {
	getReleaseNotes?: (version?: string) => Promise<ReleaseNotes | null>;
	getInstalledReleaseNotes?: () => Promise<ReleaseNotes | null>;
	acknowledgeReleaseNotes?: (version: string) => Promise<unknown>;
	openReleaseNotes?: (version: string) => Promise<unknown>;
};
export const releaseNotesBridge = () => (window as unknown as { toraWindow?: ReleaseNotesBridge }).toraWindow;
