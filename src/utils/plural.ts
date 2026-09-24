/** Format a numeric count with a singular or supplied plural noun. */
export function plural(n: number, singular: string, pluralForm = singular + 's'): string {
	return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}
