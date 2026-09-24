/* Translate generator diagnostics into bounded, actionable UI text. Never display
 * arbitrary source values or raw exception messages in the stack modal. */
export function frameworkImportError(label: string, errors: readonly string[]): string {
	const sample = errors.slice(0, 2).map((error) => {
		const row = /^Row (\d+):/.exec(error)?.[1];
		const place = row ? `Row ${row}` : 'The source';
		if (/still indexing/i.test(error)) return `${place}: the vault index is still loading. Wait for indexing, then try again.`;
		if (/\bname\b.*(?:empty|missing|undefined)|(?:empty|missing|undefined).*\bname\b|rendered empty/i.test(error))
			return `${place}: the name field is empty. Check the source name column and selected header row, then try again.`;
		if (/duplicate identity|path collision/i.test(error))
			return `${place}: two source rows resolve to one note. Check duplicate IDs and the recipe layout, then try again.`;
		if (/could not parse|unsupported source|selected table/i.test(error))
			return `${place}: the selected source table could not be read. Check the file format, sheet and header row, then try again.`;
		return `${place}: a source row could not be imported. Check its required columns and destination, then try again.`;
	});
	const more = errors.length > 2 ? ` ${errors.length - 2} more errors remain.` : '';
	const cause = sample.length ? sample.join(' ') : 'The source did not produce a valid import. Check its required columns and destination, then try again.';
	return `${label} could not be imported. ${cause}${more} Remaining frameworks were not started.`;
}
