import type { PlanCount } from '../mapping/plan';
import type { MappingForm } from '../../generation/import-set-block';

export interface StackPlanInput {
	slots: readonly { id: string; label: string; root: string; extraRoots?: string[]; mode: 'new' | 'refresh' | 'skip'; notes: PlanCount; folders?: PlanCount; extraNotes?: PlanCount; failed?: boolean; lateRefresh?: string }[];
	/**
	 * `form` is the set's storage form: the chosen form for a new set, the
	 * pinned form for a refresh. A table set writes one file whatever its row
	 * count, so `notes` then counts rows, used only for wording.
	 */
	mappings: readonly { id: string; label: string; root: string; mode: 'new' | 'refresh' | 'skip'; form: MappingForm; notes: PlanCount; folders?: PlanCount; failed?: boolean }[];
}
export type SlotPlan = StackPlanInput['slots'][number] & { newFiles: PlanCount; rewrites: PlanCount };
export type MappingPlan = StackPlanInput['mappings'][number] & { newFiles: PlanCount; rewrites: PlanCount };
export interface StackPlan {
	slots: SlotPlan[];
	mappings: MappingPlan[];
	totals: { newFiles: PlanCount; rewrites: PlanCount };
	roots: string[];
	failed: boolean;
}
const zero = (): PlanCount => ({ count: 0, exact: true });
export function planStack(inputs: StackPlanInput): StackPlan {
	const slots = inputs.slots.map((item): SlotPlan => {
		const notes = item.notes.count + (item.extraNotes?.count ?? 0);
		const files = { count: notes + (item.folders?.count ?? 0), exact: item.notes.exact && (item.extraNotes?.exact ?? true) && (item.folders?.exact ?? true) && !item.failed };
		return { ...item, extraNotes: item.extraNotes ?? zero(), newFiles: item.mode === 'new' ? files : zero(), rewrites: item.mode === 'refresh' ? { count: notes, exact: item.notes.exact && (item.extraNotes?.exact ?? true) && !item.failed } : zero() };
	});
	const mappings = inputs.mappings.map((item): MappingPlan => item.form === 'table' ? { ...item,
		// One table file, however many rows. Failure mode prevented: a table
		// run tripping the confirmation gate as if it wrote one note per row.
		newFiles: item.mode === 'new' ? { count: 1, exact: !item.failed } : zero(),
		rewrites: item.mode === 'refresh' ? { count: 1, exact: !item.failed } : zero(),
	} : { ...item,
		newFiles: item.mode === 'new' ? { count: item.notes.count + (item.folders?.count ?? 0),
			exact: item.notes.exact && (item.folders?.exact ?? true) && !item.failed } : zero(),
		rewrites: item.mode === 'refresh' ? { ...item.notes, exact: item.notes.exact && !item.failed } : zero(),
	});
	const all = [...slots, ...mappings];
	const sum = (field: 'newFiles' | 'rewrites'): PlanCount => ({
		count: all.reduce((n, item) => n + item[field].count, 0),
		exact: all.every((item) => item[field].exact),
	});
	return { slots, mappings, totals: { newFiles: sum('newFiles'), rewrites: sum('rewrites') },
		roots: [...new Set(all.filter((item) => item.mode !== 'skip').flatMap((item) =>
			[item.root, ...(('extraRoots' in item && Array.isArray(item.extraRoots)) ? item.extraRoots : [])]).filter(Boolean))],
		failed: all.some((item) => item.failed && item.mode !== 'skip') };
}
export function stackPlanTotal(plan: StackPlan): number { return plan.totals.newFiles.count + plan.totals.rewrites.count; }
export function requiresStackConfirmation(plan: StackPlan, threshold: number): boolean {
	return plan.failed || (stackPlanTotal(plan) > 0 && (threshold === 0 || stackPlanTotal(plan) > threshold));
}
export function stackPlanRow(item: SlotPlan | MappingPlan): string {
	if (item.mode === 'skip') return 'Skip: writes nothing.';
	if (item.failed) return 'Could not count this file. The import can still run.';
	const extraNotes = 'extraNotes' in item ? item.extraNotes : undefined;
	const extra = extraNotes?.count ?? 0;
	const qualifier = item.notes.exact ? '' : 'about ';
	const extraCopy = extra ? ` and ${extraNotes?.exact ? '' : 'about '}${extra.toLocaleString()} crosswalk notes` : '';
	if ('form' in item && item.form === 'table') {
		const rows = `~${item.notes.count.toLocaleString()} ${item.notes.count === 1 ? 'row' : 'rows'}`;
		return item.mode === 'refresh' ? `Refresh: rewrites 1 mapping table (${rows}) in ${item.root}.`
			: `Writes 1 mapping table (${rows}) in ${item.root}.`;
	}
	if (item.mode === 'refresh') return `Refresh: rewrites up to ${qualifier}${item.notes.count.toLocaleString()} notes in ${item.root}${extra ? ` and up to ${extra.toLocaleString()} crosswalk notes` : ''}. Unchanged notes are left alone.`;
	const folders = item.folders?.count ?? 0;
	return `Writes ${qualifier}${item.notes.count.toLocaleString()} ${'extraNotes' in item ? 'notes' : 'mapping notes'}${extraCopy}${folders ? ` and about ${folders.toLocaleString()} ${folders === 1 ? 'folder' : 'folders'}` : ''}.`;
}
export function stackPlanSummary(plan: StackPlan): string {
	const count = (value: PlanCount) => `${value.exact || plan.failed ? '' : 'about '}${value.count.toLocaleString()}`;
	const roots = plan.roots.slice(0, 3).join(', ') + (plan.roots.length > 3 ? ` and ${plan.roots.length - 3} more` : '');
	const prefix = plan.failed ? 'At least ' : 'This run writes ';
	return `${prefix}${count(plan.totals.newFiles)} new files${plan.totals.rewrites.count ? ` and may rewrite up to ${count(plan.totals.rewrites)} existing ${plan.totals.rewrites.count === 1 ? 'file' : 'files'}` : ''}${roots ? ` into ${roots}` : ''}.`;
}
