import cn from '../../i18n/flags/cn.svg';
import de from '../../i18n/flags/de.svg';
import es from '../../i18n/flags/es.svg';
import fr from '../../i18n/flags/fr.svg';
import gb from '../../i18n/flags/gb.svg';
import hk from '../../i18n/flags/hk.svg';
import india from '../../i18n/flags/in.svg';
import it from '../../i18n/flags/it.svg';
import jp from '../../i18n/flags/jp.svg';
import kr from '../../i18n/flags/kr.svg';
import pt from '../../i18n/flags/pt.svg';
import ru from '../../i18n/flags/ru.svg';
import sa from '../../i18n/flags/sa.svg';
import us from '../../i18n/flags/us.svg';
import { LANGUAGE_FLAG_COUNTRIES, normalizeLanguage } from '../../i18n/languages';

const flags = { cn, hk, gb, us, jp, kr, fr, de, it, sa, es, pt, ru, in: india };

/** Local SVGs keep the same flags on macOS, Windows and offline. */
export function LanguageFlag({ language }: { language: string }) {
	const locale = normalizeLanguage(language);
	if (!locale) return null;
	const country = LANGUAGE_FLAG_COUNTRIES[locale];
	return <img src={flags[country]} data-language-flag={country} alt="" aria-hidden="true"
		width="22" height="16.5" draggable={false}
		style={{ display: 'inline-block', width: 22, height: 16.5, flexShrink: 0, objectFit: 'contain' }} />;
}
