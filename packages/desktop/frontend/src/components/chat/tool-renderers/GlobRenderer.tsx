import { getResultText, parseInput, toolArgClass, toolLabelClass } from './_shared';
import type { ToolRenderer } from './types';
import { getToolDisplayName } from '@/lib/toolDisplayName';

function getPattern(input: string): string {
	const { pattern } = parseInput(input) as { pattern?: string };
	return pattern || input;
}

export const GlobRenderer: ToolRenderer = {
	getDisplayName: (call, t) => getToolDisplayName(call.name, t),

	renderHeader: (pair, t) => (
		<>
			<span className={toolLabelClass}>{getToolDisplayName(pair.call.name, t)}</span>
			<span className={toolArgClass}>{getPattern(pair.call.input)}</span>
		</>
	),

	renderBody: (pair) =>
		pair.result ? (
			<pre className="rounded-sm bg-muted/40 p-2 font-mono text-xs overflow-x-auto whitespace-pre">
				{getResultText(pair.result)}
			</pre>
		) : null,
};
