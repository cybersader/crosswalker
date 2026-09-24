import { MAPPING_PRESETS, RECIPE_REGISTRY, STACK_PRESETS, type MappingPreset } from '../recipe-registry';
import { activeMappings, frameworkSlots, type StackSelection } from './stack-model';

/** Persist only registry references, never bundled recipe copies or vault-specific run facts. */
export interface StackDefinition {
	id: string;
	label: string;
	createdAt: string;
	slots: Array<{ presetId: string; role: 'chosen' | 'connector' }>;
	mappings: Array<Pick<MappingPreset, 'kind' | 'from' | 'to'> & { presetId: string; fromSlot?: string }>;
	detail: StackSelection['detail'];
}

export interface SlotRunFact {
	importSetId: string;
	sourceDigest: string;
	recipeDigest: string;
	sourceName: string;
}

export interface StackRunRecord {
	stackId: string;
	finishedAt: string;
	detail: StackSelection['detail'];
	/** Framework keys are bundled recipe IDs; mapping keys are from->to:presetId. */
	slotSets: Record<string, SlotRunFact>;
	mappingSets: Record<string, SlotRunFact>;
}

export function mappingKey(mapping: Pick<MappingPreset, 'from' | 'to' | 'id'>): string {
	return `${mapping.from}->${mapping.to}:${mapping.id}`;
}

export function mintStackId(random: () => number = Math.random): string {
	return `stack-${Array.from({ length: 6 }, () => Math.floor(random() * 36).toString(36)).join('')}`;
}

export function toDefinition(selection: StackSelection, id = mintStackId(), label: string = STACK_PRESETS[0].label, createdAt = new Date().toISOString()): StackDefinition {
	const slots = frameworkSlots(selection);
	return {
		id, label, createdAt, detail: selection.detail,
		slots: slots.map(({ entry, role }) => ({ presetId: entry.id, role })),
		mappings: activeMappings(selection, slots).map((mapping) => ({
			presetId: mapping.id, kind: mapping.kind, from: mapping.from, to: mapping.to,
			...(mapping.kind === 'from-slot' ? { fromSlot: slots.find((slot) => slot.ontology === mapping.from)?.entry.id } : {}),
		})),
	};
}

export function fromDefinition(definition: StackDefinition): StackSelection {
	const chosen = definition.slots.filter((slot) => slot.role === 'chosen')
		.map((slot) => RECIPE_REGISTRY.find((entry) => entry.id === slot.presetId)!.ontology);
	return {
		chosen, detail: definition.detail,
		connectorExcluded: chosen.includes('cri-profile') && chosen.includes('nist-800-53')
			&& !definition.slots.some((slot) => slot.role === 'connector'),
		optionalMappings: definition.mappings.map((slot) => slot.presetId)
			.filter((id) => MAPPING_PRESETS.some((mapping) => mapping.id === id && mapping.optional)),
	};
}

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const detail = (value: unknown): value is StackDefinition['detail'] => value === 'max' || value === 'top-levels';
const stackId = (value: unknown): value is string => typeof value === 'string' && /^stack-[0-9a-z]{6}$/.test(value);

export function normalizeStackDefinition(value: unknown): StackDefinition | null {
	if (!object(value) || !stackId(value.id) || !nonempty(value.label) || !nonempty(value.createdAt)
		|| !detail(value.detail) || !Array.isArray(value.slots) || !Array.isArray(value.mappings)
		|| !value.slots.length) return null;
	const slots: StackDefinition['slots'] = [];
	const ontologies = new Set<string>();
	for (const slot of value.slots) {
		if (!object(slot) || !nonempty(slot.presetId) || (slot.role !== 'chosen' && slot.role !== 'connector')) return null;
		const entry = RECIPE_REGISTRY.find((candidate) => candidate.id === slot.presetId && candidate.routingKind === 'concept');
		if (!entry || ontologies.has(entry.ontology)) return null;
		ontologies.add(entry.ontology);
		slots.push({ presetId: slot.presetId, role: slot.role });
	}
	const mappings: StackDefinition['mappings'] = [];
	const keys = new Set<string>();
	for (const row of value.mappings) {
		if (!object(row) || !nonempty(row.presetId)) return null;
		const preset = MAPPING_PRESETS.find((item) => item.id === row.presetId);
		if (!preset || row.kind !== preset.kind || row.from !== preset.from || row.to !== preset.to
			|| !ontologies.has(preset.from) || !ontologies.has(preset.to) || keys.has(preset.id)) return null;
		if (preset.kind === 'from-slot' && row.fromSlot !== slots.find((slot) => RECIPE_REGISTRY.find((entry) => entry.id === slot.presetId)?.ontology === preset.from)?.presetId) return null;
		keys.add(preset.id);
		mappings.push({ presetId: preset.id, kind: preset.kind, from: preset.from, to: preset.to,
			...(preset.kind === 'from-slot' ? { fromSlot: row.fromSlot as string } : {}) });
	}
	const definition: StackDefinition = { id: value.id, label: value.label, createdAt: value.createdAt,
		slots, mappings, detail: value.detail };
	const reconstructed = toDefinition(fromDefinition(definition), definition.id, definition.label, definition.createdAt);
	return JSON.stringify(reconstructed.slots) === JSON.stringify(definition.slots)
		&& JSON.stringify(reconstructed.mappings) === JSON.stringify(definition.mappings) ? definition : null;
}

export function normalizeStackRun(value: unknown, definitions: readonly StackDefinition[]): StackRunRecord | null {
	if (!object(value) || !stackId(value.stackId) || !definitions.some((stack) => stack.id === value.stackId)
		|| !nonempty(value.finishedAt) || !detail(value.detail) || !object(value.slotSets) || !object(value.mappingSets)) return null;
	const stack = definitions.find((entry) => entry.id === value.stackId)!;
	const validSlots = new Set(stack.slots.map((slot) => slot.presetId));
	const validMappings = new Set(stack.mappings.map((mapping) => mappingKey({ ...mapping, id: mapping.presetId })));
	const facts = (input: Record<string, unknown>, valid: Set<string>): Record<string, SlotRunFact> => {
		const result: Record<string, SlotRunFact> = {};
		for (const [key, fact] of Object.entries(input)) {
			if (!valid.has(key) || !object(fact) || !nonempty(fact.importSetId) || !nonempty(fact.sourceDigest)
				|| !nonempty(fact.recipeDigest) || !nonempty(fact.sourceName)) continue;
			Object.defineProperty(result, key, { value: { importSetId: fact.importSetId, sourceDigest: fact.sourceDigest,
				recipeDigest: fact.recipeDigest, sourceName: fact.sourceName }, enumerable: true, configurable: true, writable: true });
		}
		return result;
	};
	const slotSets = facts(value.slotSets, validSlots);
	const mappingSets = facts(value.mappingSets, validMappings);
	return { stackId: value.stackId, finishedAt: value.finishedAt, detail: value.detail, slotSets, mappingSets };
}

/** Await each confirmed fact before the caller starts another slot; a later failure cannot erase it. */
export async function checkpointFrameworkOutcome(outcome: { ok: boolean; importSetId: string | null },
	sourceDigest: string | undefined, recipeDigest: string, sourceName: string,
	save: (fact: SlotRunFact) => Promise<void>): Promise<boolean> {
	if (!outcome.ok || !outcome.importSetId || !sourceDigest) return false;
	await save({ importSetId: outcome.importSetId, sourceDigest, recipeDigest, sourceName });
	return true;
}

export function normalizeStacks(value: unknown): StackDefinition[] {
	if (!Array.isArray(value)) return [];
	const ids = new Set<string>();
	return value.map(normalizeStackDefinition).filter((item): item is StackDefinition => {
		if (!item || ids.has(item.id)) return false;
		ids.add(item.id); return true;
	});
}

export function normalizeStackRuns(value: unknown, stacks: readonly StackDefinition[]): StackRunRecord[] {
	if (!Array.isArray(value)) return [];
	const runs = new Map<string, StackRunRecord>();
	for (const entry of value) {
		const run = normalizeStackRun(entry, stacks);
		if (run) runs.set(run.stackId, run);
	}
	return [...runs.values()];
}

export function replaceStackDefinition(stacks: readonly StackDefinition[], runs: readonly StackRunRecord[],
	definition: StackDefinition): { stacks: StackDefinition[]; stackRuns: StackRunRecord[] } {
	return {
		stacks: stacks.some((stack) => stack.id === definition.id)
			? stacks.map((stack) => stack.id === definition.id ? definition : stack)
			: [...stacks, definition],
		stackRuns: runs.flatMap((run) => {
			if (run.stackId !== definition.id) return [run];
			const pruned = normalizeStackRun(run, [definition]);
			return pruned ? [pruned] : [];
		}),
	};
}

export function importStackDefinition(json: string, existing: readonly StackDefinition[], random: () => number = Math.random): StackDefinition {
	let decoded: unknown;
	try { decoded = JSON.parse(json); }
	catch { throw new Error('Stack JSON is not valid. Fix its JSON syntax and try again.'); }
	if (!object(decoded)) throw new Error('Stack JSON must contain one stack definition. Export a stack and try that file again.');
	// Validate the exported structure, but never adopt its identity or any run state.
	const parsed = normalizeStackDefinition(decoded);
	if (!parsed) throw new Error('Stack JSON has missing or invalid slots, mappings, detail, or label. Export a valid stack and try again.');
	let id: string;
	do { id = mintStackId(random); } while (existing.some((stack) => stack.id === id));
	return { ...parsed, id, createdAt: new Date().toISOString() };
}

export function deleteStackRecord(stacks: readonly StackDefinition[], runs: readonly StackRunRecord[], id: string): { stacks: StackDefinition[]; stackRuns: StackRunRecord[] } {
	return { stacks: stacks.filter((stack) => stack.id !== id), stackRuns: runs.filter((run) => run.stackId !== id) };
}

export type RunChoice = 'skip' | 'refresh' | 'new';
export function slotRunChoices(fact: SlotRunFact | undefined, setPresent: boolean, sourceDigest: string | undefined,
	recipeDigest: string, guardMessage?: string | null): { choices: RunChoice[]; selected: RunChoice; message?: string } {
	if (!fact) return { choices: ['new'], selected: 'new' };
	if (!setPresent) return { choices: ['new'], selected: 'new', message: `Set ${fact.importSetId} is no longer in this vault. Import as a new set.` };
	if (fact.recipeDigest !== recipeDigest || guardMessage) return { choices: ['new'], selected: 'new',
		message: guardMessage ?? 'This set used different or unrecorded detail. Start a new set, or refresh it with the same detail as before.' };
	if (!sourceDigest) return { choices: ['skip'], selected: 'skip', message: 'Kept as imported. Drop the file again to refresh.' };
	return sourceDigest === fact.sourceDigest
		? { choices: ['skip', 'refresh', 'new'], selected: 'skip' }
		: { choices: ['refresh', 'new'], selected: 'new' };
}
