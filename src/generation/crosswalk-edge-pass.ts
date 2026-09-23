import type { App } from 'obsidian';
import type { CrosswalkColumnEntry } from '../types/generated/recipe';
import type { GenerationError, ParsedData } from '../types/config';
import type { Recipe } from '../render';
import type { DebugLog } from '../utils/debug';
import type { CrosswalkPredicate } from '../import/mapping/types';
import { splitCrosswalkCell } from '../import/detection';
import { SSSOM_CURIE_PREFIX, sssomEdgeCurie, strmToSkos } from '../import/sssom-importer';
import { assertionBaseKey } from '../utils/mapping-provenance';
import { discoverImportSets, newSetSchemeFor } from './import-set';
import { generateFromRecipe } from './generation-engine';
import { edgeEndpointIndex, resolveEdgeEndpoints, summarizeUnresolvedEndpoints, type UnresolvedEndpoint } from './edge-endpoints';

const DEFAULT_SPLIT = [',', '\n', ';'] as const;
const DEFAULT_DROP = ['None', 'N/A', '-'] as const;

export interface CrosswalkEdgeRow {
	subject_id: string;
	predicate_id: CrosswalkPredicate;
	object_id: string;
	mapping_set_id: string;
	mapping_justification: string;
	subject_label?: string;
	source_framework: string;
	target_framework: string;
	sssom_predicate: string;
}

export interface CrosswalkEdgeInput {
	curie: string;
	row: Record<string, unknown>;
	title?: string;
}

export interface CrosswalkEdgePassResult {
	perEntry: Array<{
		column: string;
		toOntology: string;
		importSetId: string | null;
		folder: string;
		created: number;
		skipped: number;
		errors: GenerationError[];
	}>;
	totalCreated: number;
	unresolved: UnresolvedEndpoint[];
	summary: string[];
	errors: GenerationError[];
}

export interface CrosswalkEdgePassArgs {
	entries: CrosswalkColumnEntry[];
	sourceOntology: string;
	recipeId: string;
	sourceFileName?: string;
	inputs: CrosswalkEdgeInput[];
	overwriteMode: 'skip' | 'replace' | 'error';
	runProjection?: (() => Promise<unknown>) | null;
	precomputeClosure?: ((source: string, target: string) => Promise<number>) | null;
	onProgress?: (current: number, total: number, message: string) => void;
}

/**
 * Derive the edge rows for one declared crosswalk column.
 *
 * Detection and generation share `splitCrosswalkCell`, so default atomization and
 * qualifier extraction cannot drift. The frozen default delimiter set is the same
 * set detection already uses (comma, semicolon, newline), so the default path calls
 * the helper exactly once. A recipe may add delimiters; those re-split each detected
 * atom, then the shared helper extracts any qualifier from each added fragment.
 */
export function deriveCrosswalkEdgeRows(
	entry: CrosswalkColumnEntry,
	sourceOntology: string,
	recipeId: string,
	inputs: CrosswalkEdgeInput[],
): { rows: CrosswalkEdgeRow[]; skippedCells: number; emptyAtoms: number } {
	const predicate = entry.predicate ?? 'is_approximate_to';
	const mappingSetId = entry.mapping_set_id ?? `${sourceOntology}-to-${entry.to_ontology}-${recipeId}`;
	const drop = new Set((entry.drop ?? DEFAULT_DROP).map((value) => value.toLocaleLowerCase()));
	const extraDelimiters = (entry.split ?? DEFAULT_SPLIT).filter(
		(delimiter) => !DEFAULT_SPLIT.includes(delimiter as (typeof DEFAULT_SPLIT)[number]),
	);
	const seenAssertions = new Set<string>();
	const rows: CrosswalkEdgeRow[] = [];
	let skippedCells = 0;
	let emptyAtoms = 0;

	for (const input of inputs) {
		const raw = input.row[entry.column];
		const cell = raw === null || raw === undefined ? '' : String(raw);
		const detected = splitCrosswalkCell(cell);
		const split = extraDelimiters.length === 0
			? detected
			: detected.atoms.reduce<{ atoms: string[]; qualifiers: (string | null)[] }>((expanded, atom, index) => {
				let fragments = [`${atom}${detected.qualifiers[index] ? ` ${detected.qualifiers[index]}` : ''}`];
				for (const delimiter of extraDelimiters) {
					fragments = fragments.flatMap((fragment) => fragment.split(delimiter));
				}
				for (const fragment of fragments) {
					const nested = splitCrosswalkCell(fragment);
					expanded.atoms.push(...nested.atoms);
					expanded.qualifiers.push(...nested.qualifiers);
				}
				return expanded;
			}, { atoms: [], qualifiers: [] });
		let emittedForCell = 0;

		for (let index = 0; index < split.atoms.length; index += 1) {
			const atom = split.atoms[index];
			if (drop.has(atom.toLocaleLowerCase())) {
				emptyAtoms += 1;
				continue;
			}
			const objectId = atom.startsWith(`${entry.to_ontology}:`)
				? atom
				: `${entry.to_ontology}:${atom}`;
			const assertionKey = assertionBaseKey({
				subject_id: input.curie,
				predicate_id: predicate,
				predicate_modifier: '',
				object_id: objectId,
			});
			if (seenAssertions.has(assertionKey)) continue;
			seenAssertions.add(assertionKey);

			rows.push({
				subject_id: input.curie,
				predicate_id: predicate,
				object_id: objectId,
				mapping_set_id: mappingSetId,
				mapping_justification: entry.qualifier === 'strip' ? '' : (split.qualifiers[index] ?? ''),
				subject_label: input.title ?? '',
				source_framework: sourceOntology,
				target_framework: entry.to_ontology,
				sssom_predicate: strmToSkos(predicate),
			});
			emittedForCell += 1;
		}

		if (emittedForCell === 0) skippedCells += 1;
		if (cell.trim() !== '' && split.atoms.length === 0) emptyAtoms += 1;
	}

	return { rows, skippedCells, emptyAtoms };
}

/** Build the synthetic recipe used for one concept-source crosswalk column. */
export function buildCrosswalkColumnRecipe(
	entry: CrosswalkColumnEntry,
	sourceOntology: string,
	recipeId: string,
): Recipe {
	const target = entry.to_ontology;
	return {
		recipe: `${recipeId}::crosswalk::${slug(entry.column)}`,
		source: { ontology: SSSOM_CURIE_PREFIX, levels: ['mapping'] },
		target: {
			layout: [
				{
					level: 'mapping',
					mechanism: 'file',
					template: '{_crosswalker_curie_local_part|slug}.md',
					kind: 'crosswalk-edge',
				},
			],
			also_emit: {
				tags: [`crosswalk/${sourceOntology}-to-${target}`],
				frontmatter: {
					managed: {
						title: '{subject_id} -> {object_id}',
						predicate_id: '{predicate_id}',
						subject_id: '{subject_id}',
						object_id: '{object_id}',
						subject_note: '{subject_note|optional}',
						object_note: '{object_note|optional}',
						subject_label: '{subject_label}',
						mapping_justification: '{mapping_justification}',
						mapping_set_id: '{mapping_set_id}',
						source_framework: sourceOntology,
						target_framework: target,
						sssom_predicate: '{sssom_predicate}',
					},
					user_preserve: ['review_status', 'reviewer', '*notes*'],
				},
				body: [{ template: '{edge_body}', position: 'append', format: 'text' }],
			},
		},
	};
}

/** Run every declared crosswalk column as its own SSSOM-owned edge import. */
export async function runCrosswalkEdgePass(
	app: App,
	args: CrosswalkEdgePassArgs,
	debug?: DebugLog,
): Promise<CrosswalkEdgePassResult> {
	const result: CrosswalkEdgePassResult = { perEntry: [], totalCreated: 0, unresolved: [], summary: [], errors: [] };
	const { index, unreadable } = await edgeEndpointIndex(app);

	for (const entry of args.entries) {
		const folder = `_crosswalker/mappings/${args.sourceOntology}-to-${entry.to_ontology}`;
		const derived = deriveCrosswalkEdgeRows(entry, args.sourceOntology, args.recipeId, args.inputs);
		if (derived.rows.length === 0) {
			debug?.info('crosswalk-edge-pass', 'no-edges', `No crosswalk edges to write for ${entry.column}`, {
				column: entry.column,
				skippedCells: derived.skippedCells,
				emptyAtoms: derived.emptyAtoms,
			});
			result.perEntry.push({
				column: entry.column,
				toOntology: entry.to_ontology,
				importSetId: null,
				folder,
				created: 0,
				skipped: 0,
				errors: [],
			});
			continue;
		}

		const resolvedRows = derived.rows.map((row) => {
			const resolved = resolveEdgeEndpoints(index, { ...row });
			result.unresolved.push(...resolved.unresolved);
			return { ...row, subject_note: resolved.subject_note, object_note: resolved.object_note, edge_body: resolved.edge_body };
		});
		const parsedData: ParsedData = {
			columns: Array.from(new Set(resolvedRows.flatMap((row) => Object.keys(row)))),
			rows: resolvedRows,
			rowCount: derived.rows.length,
		};
		const importSet = await newSetSchemeFor(app, SSSOM_CURIE_PREFIX);
		const generation = await generateFromRecipe(
			app,
			parsedData,
			buildCrosswalkColumnRecipe(entry, args.sourceOntology, args.recipeId),
			{
				basePath: folder,
				overwriteMode: args.overwriteMode,
				createFolders: true,
				importSet,
				sourceFileName: args.sourceFileName,
				strictValidation: true,
				curieLocalPart: (row, _rowNumber, set) => sssomEdgeCurie(row, set),
				curiePrefix: SSSOM_CURIE_PREFIX,
				onProgress: args.onProgress,
			},
			debug,
		);

		if (generation.success && args.runProjection) {
			try {
				await args.runProjection();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				generation.errors.push({ row: -1, message: `Tier 2 projection failed: ${message}` });
				debug?.warn('crosswalk-edge-pass', 'projection-failed', 'Crosswalk edge projection failed', { error: message });
			}
		}
		if (generation.success && args.precomputeClosure) {
			try {
				await args.precomputeClosure(args.sourceOntology, entry.to_ontology);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				generation.errors.push({ row: -1, message: `Closure precompute failed: ${message}` });
				debug?.warn('crosswalk-edge-pass', 'precompute-failed', 'Crosswalk edge closure precompute failed', { error: message });
			}
		}

		let importSetId: string | null = null;
		try {
			const created = new Set(generation.created);
			const sets = await discoverImportSets(app, folder);
			importSetId = sets.find((set) => set.paths.some((path) => created.has(path)))?.id ?? null;
		} catch (error) {
			debug?.warn('crosswalk-edge-pass', 'set-discovery-failed', 'Could not read the new crosswalk import set id', {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		const entryResult = {
			column: entry.column,
			toOntology: entry.to_ontology,
			importSetId,
			folder,
			created: generation.created.length,
			skipped: generation.skipped.length,
			errors: generation.errors,
		};
		result.perEntry.push(entryResult);
		result.totalCreated += generation.created.length;
		result.errors.push(...generation.errors);
	}

	result.summary = summarizeUnresolvedEndpoints(result.unresolved, unreadable);
	return result;
}

function slug(value: string): string {
	return value
		.trim()
		.toLocaleLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'column';
}
