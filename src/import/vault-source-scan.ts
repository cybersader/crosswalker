import * as Papa from 'papaparse';
import { iterateJsonPath, toSourceRows } from './parsers/json-source-core';
import {
	CANDIDATE_FLOOR,
	CONFIDENT_MATCH_THRESHOLD,
	matchScore,
	type RecipeRegistryEntry,
} from './recipe-registry';

export { PEEK_ROWS, type TablePeek } from './parsers/table-peek';
import { PEEK_ROWS, type TablePeek } from './parsers/table-peek';

export const MAX_HEADER_PROBE = 8;
export const MIN_SIGNATURE_COLUMNS = 3;
export const MAX_FILES_PER_SCAN = 500;

/** Read the first rows of a CSV or TSV source without assigning a header. */
export function peekCSV(text: string, rows = PEEK_ROWS): TablePeek[] {
	const limit = Math.max(0, Math.floor(rows));
	if (limit === 0) return [{ table: '', rows: [] }];

	const parsed = Papa.parse<string[]>(text, {
		delimiter: '',
		header: false,
		skipEmptyLines: true,
		dynamicTyping: false,
		preview: limit,
	});
	return [
		{
			table: '',
			rows: parsed.data.map((row) => row.map((cell) => String(cell ?? '').trim())),
		},
	];
}

interface JsonIteratorCandidate {
	iterator: string;
}

function jsonIteratorCandidates(root: unknown): JsonIteratorCandidate[] {
	if (Array.isArray(root)) return [{ iterator: '$[*]' }];
	if (root === null || typeof root !== 'object') return [];

	const object = root as Record<string, unknown>;
	const candidates: JsonIteratorCandidate[] = [];
	for (const [key, value] of Object.entries(object)) {
		if (Array.isArray(value)) candidates.push({ iterator: `$.${key}[*]` });
	}
	for (const [key, value] of Object.entries(object)) {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
		for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
			if (Array.isArray(childValue)) candidates.push({ iterator: `$.${key}.${childKey}[*]` });
		}
	}
	return candidates;
}

/** Find candidate JSON record lists and return their union-of-keys headers. */
export function peekJSON(text: string, rows = PEEK_ROWS): TablePeek[] {
	const root: unknown = JSON.parse(text);
	const limit = Math.max(0, Math.floor(rows));
	return jsonIteratorCandidates(root).map(({ iterator }) => {
		const sourceRows = toSourceRows(iterateJsonPath(root, iterator)).rows.slice(0, limit);
		const header: string[] = [];
		const seen = new Set<string>();
		for (const row of sourceRows) {
			for (const key of Object.keys(row)) {
				if (seen.has(key)) continue;
				seen.add(key);
				header.push(key);
			}
		}
		return { table: iterator, rows: [header] };
	});
}

export interface ScanCandidate {
	path: string;
	entryId: string;
	label: string;
	table: string;
	headerRow: number;
	score: number;
	confident: boolean;
}

interface RankedCandidate extends ScanCandidate {
	structuralDepth: number;
	signatureLength: number;
	registryOrder: number;
}

function isBetterCandidate(candidate: RankedCandidate, current: RankedCandidate | null): boolean {
	if (current === null) return true;
	if (candidate.score !== current.score) return candidate.score > current.score;
	if (candidate.structuralDepth !== current.structuralDepth) {
		return candidate.structuralDepth > current.structuralDepth;
	}
	if (candidate.signatureLength !== current.signatureLength) {
		return candidate.signatureLength > current.signatureLength;
	}
	return candidate.registryOrder < current.registryOrder;
}

/** Score every plausible header row and return the best recognized source. */
export function scoreFilePeeks(
	path: string,
	fileName: string,
	peeks: TablePeek[],
	registry: RecipeRegistryEntry[],
): ScanCandidate | null {
	let best: RankedCandidate | null = null;

	for (const peek of peeks) {
		const lastHeaderRow = Math.min(peek.rows.length - 1, MAX_HEADER_PROBE);
		for (let headerRow = 0; headerRow <= lastHeaderRow; headerRow++) {
			const columns = peek.rows[headerRow]
				.map((cell) => String(cell ?? '').trim())
				.filter((cell) => cell !== '' && !cell.startsWith('__EMPTY'));
			if (columns.length < MIN_SIGNATURE_COLUMNS) continue;

			for (let registryOrder = 0; registryOrder < registry.length; registryOrder++) {
				const entry = registry[registryOrder];
				const score = matchScore(entry, columns);
				if (score < CANDIDATE_FLOOR) continue;
				const candidate: RankedCandidate = {
					path,
					entryId: entry.id,
					label: entry.label,
					table: peek.table,
					headerRow,
					score,
					confident: score >= CONFIDENT_MATCH_THRESHOLD,
					structuralDepth: entry.structuralDepth,
					signatureLength: entry.signatureColumns.length,
					registryOrder,
				};
				if (isBetterCandidate(candidate, best)) best = candidate;
			}
		}
	}

	// A filename hint can break otherwise equal ties after source.detect ships.
	void fileName;
	if (best === null) return null;
	const { structuralDepth: _depth, signatureLength: _length, registryOrder: _order, ...result } = best;
	return result;
}

export interface KnownSource {
	setId: string;
	file: string | null;
	sourceHash: string | null;
	producedAt: string | null;
}

export type SourceState =
	| { kind: 'not-imported' }
	| { kind: 'imported-unchanged'; setId: string; producedAt: string | null }
	| { kind: 'imported-changed'; setId: string; producedAt: string | null }
	| { kind: 'index-cold' };

function basename(path: string): string {
	const parts = path.split('/');
	return parts[parts.length - 1] ?? path;
}

/** Reconcile one source candidate against provenance already found in the vault. */
export function reconcileCandidate(
	fileName: string,
	sourceDigest: string,
	known: KnownSource[],
	indexReady: boolean,
): SourceState {
	if (!indexReady) return { kind: 'index-cold' };

	const unchanged = known.find((source) => source.sourceHash === sourceDigest);
	if (unchanged) {
		return {
			kind: 'imported-unchanged',
			setId: unchanged.setId,
			producedAt: unchanged.producedAt,
		};
	}

	const candidateName = basename(fileName);
	const changed = known.find(
		(source) => source.file !== null && basename(source.file) === candidateName && source.sourceHash !== sourceDigest,
	);
	if (changed) {
		return {
			kind: 'imported-changed',
			setId: changed.setId,
			producedAt: changed.producedAt,
		};
	}

	return { kind: 'not-imported' };
}

export interface ScanPlan {
	files: string[];
	skipped: { path: string; reason: 'over-cap' | 'inside-import-set' | 'managed-folder' }[];
}

function isInside(path: string, root: string): boolean {
	const normalizedRoot = root.replace(/\/+$/, '');
	return normalizedRoot !== '' && (path === normalizedRoot || path.startsWith(`${normalizedRoot}/`));
}

/** Apply managed-folder exclusions and the bounded scan cap in caller order. */
export function planScan(
	paths: string[],
	importSetRoots: string[],
	managedRoot = '_crosswalker',
): ScanPlan {
	const plan: ScanPlan = { files: [], skipped: [] };
	for (const path of paths) {
		if (importSetRoots.some((root) => isInside(path, root))) {
			plan.skipped.push({ path, reason: 'inside-import-set' });
			continue;
		}
		if (isInside(path, managedRoot)) {
			plan.skipped.push({ path, reason: 'managed-folder' });
			continue;
		}
		if (plan.files.length >= MAX_FILES_PER_SCAN) {
			plan.skipped.push({ path, reason: 'over-cap' });
			continue;
		}
		plan.files.push(path);
	}
	return plan;
}
