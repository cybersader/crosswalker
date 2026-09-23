/** Pure stack-slot recognition over already peeked source headers. */
import {
	CANDIDATE_FLOOR, CONFIDENT_MATCH_THRESHOLD, canonicalHeaderColumns, matchScore, RECIPE_REGISTRY,
	type RecipeRegistryEntry,
} from '../recipe-registry';
import type { TablePeek } from '../parsers/table-peek';
import { suggestWorkbookBinding } from '../workbook-suggestion';
import { activeMappings, type FrameworkSlot, type StackSelection } from './stack-model';
import type { MappingPreset } from '../recipe-registry';

export interface StackSource { path: string; name: string; peeks: TablePeek[] }
export interface StackCandidate {
	source: StackSource;
	slot: FrameworkSlot;
	table: string;
	headerRow: number;
	score: number;
	matched: number;
	expected: number;
}
export interface MappingCandidate { source: StackSource; mapping: MappingPreset; table: string; headerRow: number }
export interface StackRecognition {
	mappingFills: MappingCandidate[];
	fills: StackCandidate[];
	mightMatch: StackCandidate[];
	ambiguities: { source: StackSource; candidates: StackCandidate[]; message: string }[];
	wrongFiles: { source: StackSource; slot: FrameworkSlot | null; message: string }[];
	notInStack: { source: StackSource; entry: RecipeRegistryEntry }[];
}
const norm = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

function hintRank(entry: RecipeRegistryEntry, source: StackSource, table: string, headerRow: number): number {
	const detect = entry.recipe.source.detect;
	if (!detect) return 0;
	return Number(headerRow === detect.header_row) + Number(
		[detect.sheet, ...(detect.sheet_aliases ?? [])].some((hint) => hint && norm(hint) === norm(table)),
	) + Number(Boolean(detect.filename?.some((hint) => norm(source.name).includes(norm(hint)))));
}

function bestForSlot(source: StackSource, slot: FrameworkSlot): StackCandidate | null {
	const entry = slot.entry;
	// Reuse the workbook sheet/header suggestion before comparing every slot header.
	const suggestion = /\.xlsx?$/i.test(source.name) ? suggestWorkbookBinding(source.peeks.map((peek) => ({ ...peek,
			rows: peek.rows.map((columns) => canonicalHeaderColumns(columns, entry)) })), source.name, [entry]) : null;
	const candidates: (StackCandidate & { rank: number })[] = [];
	for (const peek of source.peeks) {
		for (let headerRow = 0; headerRow < Math.min(peek.rows.length, 9); headerRow++) {
			const columns = peek.rows[headerRow].map((value) => value.trim()).filter((value) => value && !value.startsWith('__EMPTY'));
			if (columns.length < 2) continue;
			const score = matchScore(entry, canonicalHeaderColumns(columns, entry));
			if (score < CANDIDATE_FLOOR) continue;
			const have = new Set(columns.map(norm));
			const matched = entry.signatureColumns.filter((column) => have.has(norm(column)) ||
				(entry.headerAliases?.[column] ?? []).some((alias) => have.has(norm(alias)))).length;
			candidates.push({ source, slot, table: peek.table, headerRow, score, matched,
				expected: entry.signatureColumns.length,
				rank: hintRank(entry, source, peek.table, headerRow) +
					Number(suggestion?.sheetName === peek.table && suggestion.headerRow === headerRow) });
		}
	}
	candidates.sort((a, b) => b.score - a.score || b.rank - a.rank || a.headerRow - b.headerRow);
	if (!candidates.length) return null;
	const { rank: _rank, ...candidate } = candidates[0];
	return candidate;
}

function recognizeMappingSource(source: StackSource, mappings: readonly MappingPreset[]): MappingCandidate | null {
	const name = source.name.toLowerCase();
	for (const peek of source.peeks) {
		if (peek.table === '$.mapping_objects[*]' && /\.json$/i.test(name) &&
			peek.rows.some((row) => ['capability_id', 'attack_object_id', 'mapping_type'].every((key) => row.includes(key)))) {
			const id = /cri|profile/.test(name) ? 'cri-attack' : '80053-attack';
			const mapping = mappings.find((item) => item.id === id);
			if (mapping) return { source, mapping, table: peek.table, headerRow: 0 };
		}
		if (!/\.xlsx?$/i.test(name)) continue;
		for (let headerRow = 0; headerRow < Math.min(peek.rows.length, 9); headerRow++) {
			const headers = peek.rows[headerRow].map(norm);
			if (!headers.includes('focal document element') || !headers.includes('reference document element')) continue;
			const id = /cri|profile/.test(name) ? 'cri-80053' : /csf|cybersecurity.framework/i.test(name) ? 'csf-80053' : null;
			const mapping = mappings.find((item) => item.id === id);
			if (mapping) return { source, mapping, table: peek.table, headerRow };
		}
	}
	return null;
}

/** A hint only breaks ties; it cannot admit a file missing a required column. */
export function recognizeStackSources(
	sources: readonly StackSource[], slots: readonly FrameworkSlot[],
	registry: readonly RecipeRegistryEntry[] = RECIPE_REGISTRY,
	selection?: StackSelection,
): StackRecognition {
	const result: StackRecognition = { mappingFills: [], fills: [], mightMatch: [], ambiguities: [], wrongFiles: [], notInStack: [] };
	const mappings = selection ? activeMappings(selection, slots).filter((mapping) => mapping.kind === 'download' || mapping.kind === 'built-in') : [];
	for (const source of sources) {
		const mapping = recognizeMappingSource(source, mappings);
		if (mapping) {
			if (result.mappingFills.some((item) => item.mapping.id === mapping.mapping.id)) {
				result.wrongFiles.push({ source, slot: null, message: `${mapping.mapping.label} already has a mapping file. Keep one publisher export and try again.` });
			} else result.mappingFills.push(mapping);
			continue;
		}
		const scored = slots.map((slot) => bestForSlot(source, slot)).filter((candidate): candidate is StackCandidate => !!candidate)
			.sort((a, b) => b.score - a.score || b.expected - a.expected);
		const best = scored[0];
		// Wrong-file checks explain a miss; they never override a confident match elsewhere in the file.
		const confident = !!best && best.score >= CONFIDENT_MATCH_THRESHOLD;
		const cis = slots.find((slot) => slot.ontology === 'cis-v8');
		if (!confident && cis && source.peeks.some((peek) => /change log/i.test(peek.table))) {
			result.wrongFiles.push({ source, slot: cis, message:
				'This CIS Change Log sheet lists changes, not safeguards. Choose the workbook sheet that lists safeguards.' });
			continue;
		}
		if (!confident && /\.xlsx?$/i.test(source.name) && source.peeks.some((peek) =>
			peek.rows.some((row) => row.some((cell) => /focal.document|reference.document/i.test(cell)))) &&
			slots.some((slot) => slot.ontology === 'nist-csf-2')) {
			result.wrongFiles.push({ source, slot: null, message:
				'This is an OLIR mapping workbook, not a framework catalog. Choose the matching mapping slot in the picker, or use a filename identifying the mapped frameworks and try again.' });
			continue;
		}
		const cri = slots.find((slot) => slot.ontology === 'cri-profile');
		if (cri && !best && source.peeks.some((peek) => /CRI Profile v2\.2 Structure/i.test(peek.table)
			&& peek.rows[0]?.some((cell) => /CRI Profile/i.test(cell)))) {
			result.wrongFiles.push({ source, slot: cri, message:
				'The CRI structure sheet starts with two banner rows. Choose header row 3 (index 2) and try again.' });
			continue;
		}
		const attack = slots.find((slot) => slot.ontology === 'mitre-attack');
		if (/\.json$/i.test(source.name) && attack && source.peeks.some((peek) =>
			peek.table === '$.objects[*]' && peek.rows.some((row) => row.some((cell) => norm(cell) === 'type')))) {
			result.wrongFiles.push({ source, slot: attack, message:
				'This is the ATT&CK STIX bundle. This stack expects the Excel export. Download enterprise-attack.xlsx from the checklist.' });
			continue;
		}
		if (!best) {
			const outside = registry.filter((entry) => !slots.some((slot) => slot.entry.id === entry.id))
				.map((entry) => bestForSlot(source, { ontology: entry.ontology, role: 'chosen', entry }))
				.filter((candidate): candidate is StackCandidate => !!candidate && candidate.score >= CONFIDENT_MATCH_THRESHOLD)
				.sort((a, b) => b.score - a.score)[0];
			if (outside) result.notInStack.push({ source, entry: outside.slot.entry });
			else result.wrongFiles.push({ source, slot: null,
				message: `No stack slot recognizes ${source.name}. Choose a publisher export from the checklist or another file.` });
			continue;
		}
		if (best.score < CONFIDENT_MATCH_THRESHOLD) { result.mightMatch.push(best); continue; }
		const tied = scored.filter((candidate) => candidate.score === best.score && candidate.expected === best.expected);
		if (tied.length > 1) {
			result.ambiguities.push({ source, candidates: tied,
				message: `${source.name} matches multiple stack slots. Choose the correct slot before importing.` });
			continue;
		}
		const prior = result.fills.find((candidate) => candidate.slot.ontology === best.slot.ontology);
		if (prior) {
			result.ambiguities.push({ source, candidates: [prior, best], message:
				`Slot ${best.slot.entry.label} already has ${prior.source.name}. Replace it with ${source.name}, or keep the first file.` });
			continue;
		}
		result.fills.push(best);
	}
	return result;
}
