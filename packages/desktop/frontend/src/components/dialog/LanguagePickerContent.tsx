import type { ReactNode } from 'react';

import { LanguageFlag } from './LanguageFlag';
import './language-picker.css';

export type LanguagePickerOption = { value: string; name: string };

/** Shared presentation for the website, desktop app and ToChat web. */
export function LanguagePickerContent({
  title, closeLabel, searchLabel, search, onSearch, inputRef, options,
  current, busy = false, busyLabel, error, emptyLabel, onSelect, onClose,
}: {
  title: ReactNode;
  closeLabel: string;
  searchLabel: string;
  search: string;
  onSearch: (value: string) => void;
  inputRef?: { current: HTMLInputElement | null };
  options: readonly LanguagePickerOption[];
  current: string;
  busy?: boolean;
  busyLabel?: string;
  error?: string | null;
  emptyLabel?: string;
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  return <>
    <div className="language-picker-heading">
      {title}
      <button type="button" aria-label={closeLabel} onClick={onClose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m5 5 14 14M19 5 5 19" /></svg>
      </button>
    </div>
    <input ref={inputRef} type="search" autoComplete="off" spellCheck={false}
      value={search} onChange={event => onSearch(event.target.value)}
      placeholder={searchLabel} aria-label={searchLabel} dir="auto" />
    <div className="language-picker-list" role="group" aria-label={searchLabel} aria-busy={busy}>
      {options.map(option => <button key={option.value} type="button" lang={option.value} dir="auto"
        aria-pressed={current === option.value} disabled={busy} onClick={() => onSelect(option.value)}>
        <span className="language-picker-option-name"><LanguageFlag language={option.value} /><span>{option.name.includes('（') ? <>{option.name.slice(0, option.name.indexOf('（'))}<wbr /><span className="language-picker-region">{option.name.slice(option.name.indexOf('（'))}</span></> : option.name}</span></span>{current === option.value && <span aria-hidden="true">✓</span>}
      </button>)}
    </div>
    {!options.length && emptyLabel && <p role="status">{emptyLabel}</p>}
    {busy && busyLabel && <p role="status">{busyLabel}</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}
