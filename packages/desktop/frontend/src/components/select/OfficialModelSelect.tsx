import {ChevronDown} from 'lucide-react';

import GeminiLogo from '@/assets/providers/lobe-gemini-color.svg?react';
import OpenAILogo from '@/assets/providers/openai-black-monoblossom.svg?react';
import AnthropicLogo from '@/assets/providers/si-anthropic.svg?react';
import DeepSeekLogo from '@/assets/providers/si-deepseek.svg?react';
import VolcengineLogo from '@/assets/providers/site-volcengine.png';
import {DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/dropdown-menu';
import {Tooltip,TooltipContent,TooltipTrigger} from '@/components/ui/tooltip';
import {useTranslation} from '@/i18n/useI18n';
import {TOCHAT_MODELS, modelAllowedInMode, modelAvailable, toChatModel, type ToChatModelId, type ToChatModelAvailability} from '@/lib/tochatModels';

function ModelIcon({model}: {model: string}) {
 if(model.startsWith('doubao')) return <img src={VolcengineLogo} alt="" className="size-4 shrink-0" />;
 if(model.startsWith('gemini')) return <GeminiLogo className="size-4 shrink-0" />;
 if(model.startsWith('claude')) return <AnthropicLogo className="size-4 shrink-0 dark:invert" />;
 if(model.startsWith('gpt')) return <OpenAILogo className="size-4 shrink-0 dark:invert" />;
 return <DeepSeekLogo data-testid="official-deepseek-logo" className="size-4 shrink-0" />;
}

/** Restore the original radio model menu, with the original thinking options. */
export function OfficialModelSelect({model, effort, models, disabled, onModel, onEffort, className = '', mode = 'work'}: {
 mode?: 'chat' | 'work'; model: ToChatModelId; effort: string; models?: ToChatModelAvailability[]; disabled?: boolean;
 onModel: (id: ToChatModelId) => void; onEffort: (level: string) => void; className?: string;
}) {
 const {t} = useTranslation(), selected = toChatModel(model);
 return <DropdownMenu><DropdownMenuTrigger disabled={disabled} aria-label={t('llm-select.placeholder')} className={`inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-sm hover:bg-muted ${className}`}>
  <span aria-hidden="true"><ModelIcon model={model} /></span><span className="web-model-name truncate">{selected.name}</span><span className="shrink-0 text-muted-foreground">{t(`llm-select.level.${effort}`)}</span><ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
 </DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-60 max-w-[calc(100vw-24px)]">
  <DropdownMenuRadioGroup value={model} onValueChange={id => onModel(id as ToChatModelId)}>{TOCHAT_MODELS.filter(item => modelAllowedInMode(item.id,mode)).map(item => <DropdownMenuRadioItem key={item.id} value={item.id} disabled={disabled || !modelAvailable(item.id,models)}><span aria-hidden="true"><ModelIcon model={item.id} /></span>{item.name}{!modelAllowedInMode(item.id,'work') && <Tooltip disableHoverableContent><TooltipTrigger asChild><span data-testid="doubao-free-label" className="ms-auto cursor-help text-xs text-muted-foreground">{t('llm-select.freeChatModel')}</span></TooltipTrigger><TooltipContent side="top" align="end" sideOffset={6} collisionPadding={8} className="max-w-72 text-left leading-5">{t('llm-select.freeChatModelHint')}</TooltipContent></Tooltip>}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
  <DropdownMenuSeparator /><DropdownMenuRadioGroup value={effort} onValueChange={onEffort}>{selected.efforts.map(level => <DropdownMenuRadioItem key={level} value={level} disabled={disabled}>{t(`llm-select.level.${level}`)}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
 </DropdownMenuContent></DropdownMenu>;
}
