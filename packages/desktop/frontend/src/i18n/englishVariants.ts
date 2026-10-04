/** Convert user-facing copy; interpolation, markup and code examples stay exact. */
export function britishEnglish(text: string): string {
	const spelling: Record<string, string> = {
		behavior: 'behaviour', behaviors: 'behaviours', color: 'colour', colors: 'colours',
		center: 'centre', centers: 'centres', organization: 'organisation', organizations: 'organisations',
		organize: 'organise', organized: 'organised', organizing: 'organising',
		favorite: 'favourite', favorites: 'favourites', customize: 'customise', customized: 'customised',
		customization: 'customisation', license: 'licence', licenses: 'licences',
	};
	return text.split(/(\{\{[^{}]*\}\}|`[^`]*`|<\/?[A-Za-z][^>]*>|https?:\/\/\S+)/g).map((part, index) => index % 2 ? part :
		part.replace(/\b(?:behaviors?|colors?|centers?|organizations?|organize|organized|organizing|favorites?|customize|customized|customization|licenses?)\b/gi, word => {
			const replacement = spelling[word.toLowerCase()];
			return word === word.toUpperCase() ? replacement.toUpperCase() : /^[A-Z]/.test(word) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
		})).join('');
}
