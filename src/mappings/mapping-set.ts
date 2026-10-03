/**
 * mapping-set.ts — the release record of one mapping set (v0.1.7 Track 3).
 *
 * A mapping set (one published crosswalk release) gets one record holding its
 * identity, version, participants, provenance, license, assertion count and two
 * digests. It is stored once per set, in the set's own storage form:
 *
 *   notes form   one note with `kind: mapping-set`, bound to its set by
 *                `_crosswalker.import_set.id` (never by file name or folder)
 *   table form   the `mapping_set` header key of the set's mapping table
 *                (the same object without `_crosswalker`)
 *
 * One reader (`readMappingSet`) returns one type from either form, and returns
 * `undefined` for a set written before records existed. It never derives a
 * record from rows: a set without one is a set without one.
 *
 * Contract: spec/tier1.schema.json `$defs.mapping_set_frontmatter`.
 */

import type { App, TFile } from 'obsidian';
import { sha256Hex } from '../generation/hash';
import { buildNoteContent, sanitizeFileName } from '../generation/generation-engine';
import { readNoteFrontmatterState } from '../export/vault-reader';
import { normalizeFolderSetting } from '../settings/folder-settings';
import type { DiscoveredImportSet } from '../generation/import-set';
import type { SssomHeader } from '../import/sssom-parser';
import type { MappingTableHeader } from './mapping-table';
import { readMappingTables } from './mapping-table-reader';
import { importSetIdOf } from './conversion-marker';
import { normalizeMappingSetId } from '../utils/mapping-provenance';

/** The Tier 1 discriminator of a release record. */
export const MAPPING_SET_KIND = 'mapping-set';

export type MappingSetIdOrigin = 'declared' | 'minted';

/** The release record (spec/tier1.schema.json `mapping_set_frontmatter` minus `_crosswalker`). */
export interface MappingSetRecord {
	mapping_set_id: string;
	id_origin: MappingSetIdOrigin;
	mapping_set_version?: string;
	mapping_set_title?: string;
	mapping_set_description?: string;
	subject_source?: string;
	subject_source_version?: string;
	object_source?: string;
	object_source_version?: string;
	mapping_provider?: string;
	mapping_date?: string;
	creator_id?: string[];
	license?: string;
	assertion_count: number;
	membership_digest: string;
	content_digest: string;
	/** The import set the record belongs to. Read from where it is stored, never written into the record. */
	importSetId: string;
}

/** The stored shape: the record without `importSetId`, with `kind` first. */
export type StoredMappingSet = Record<string, unknown>;

/** Declared text fields, in the order they are written. */
const DECLARED_TEXT_FIELDS = [
	'mapping_set_version', 'mapping_set_title', 'mapping_set_description',
	'subject_source', 'subject_source_version', 'object_source', 'object_source_version',
	'mapping_provider', 'mapping_date',
] as const;
type DeclaredTextField = typeof DECLARED_TEXT_FIELDS[number];

const MINTED_ID_PATTERN = /^urn:crosswalker:mapping-set:[a-z2-7]{10}$/;
const DIGEST_PATTERN = /^sha256-[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Digests (M4)
// ---------------------------------------------------------------------------

/**
 * The assertion facts a digest reads: the row-id facts (`MappingRowIdBase`
 * minus the set id, which the record holds once) plus the three evidence
 * fields. `predicate_id` is the STRM predicate.
 */
export interface MappingSetAssertionFacts {
	subject_id: string;
	predicate_id: string;
	object_id: string;
	predicate_modifier?: string;
	mapping_justification?: string;
	confidence?: string | number;
	mapping_provider?: string;
}

export interface MappingSetDigests {
	membership_digest: string;
	content_digest: string;
	assertion_count: number;
}

/**
 * One text form for a confidence, whichever form stored it: the table keeps
 * `0.90` as text, note YAML hands back the number 0.9, SSSOM parsing yields a
 * number. Numeric-looking values compare by number. Failure mode prevented: the
 * same release digesting differently in its two storage forms.
 */
function confidenceText(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
	const text = String(value).trim();
	if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return String(Number(text));
	return text;
}

function factText(value: unknown): string {
	if (value === undefined || value === null) return '';
	return String(value).trim();
}

/**
 * Membership and content digests of a set's rows (M4). Order independent;
 * review columns, labels, notes, extra fields, row ids and ordinals never enter
 * either digest, so reviewing a set never changes its integrity. Pure.
 */
export function computeMappingSetDigests(rows: Iterable<MappingSetAssertionFacts>): MappingSetDigests {
	const membership: string[] = [];
	const content: string[] = [];
	for (const row of rows) {
		const claim = [
			factText(row.subject_id), factText(row.predicate_id), factText(row.object_id),
			row.predicate_modifier === 'NOT' ? 'NOT' : '',
		].join('\t');
		membership.push(claim);
		content.push([
			claim, factText(row.mapping_justification), confidenceText(row.confidence), factText(row.mapping_provider),
		].join('\t'));
	}
	const digest = (lines: string[]) => `sha256-${sha256Hex([...lines].sort().join('\n'))}`;
	return {
		membership_digest: digest(membership),
		content_digest: digest(content),
		assertion_count: membership.length,
	};
}

// ---------------------------------------------------------------------------
// Identity (M2)
// ---------------------------------------------------------------------------

/** Mint a meaningless release id: `urn:crosswalker:mapping-set:` plus 10 base32 characters. */
export function mintMappingSetId(): string {
	const cryptoApi = globalThis.crypto;
	if (!cryptoApi?.getRandomValues) {
		throw new Error('Secure random generation is unavailable; cannot mint a mapping set id.');
	}
	const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
	const bytes = new Uint8Array(10);
	cryptoApi.getRandomValues(bytes);
	let suffix = '';
	for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
	return `urn:crosswalker:mapping-set:${suffix}`;
}

export function isMintedMappingSetId(id: string): boolean {
	return MINTED_ID_PATTERN.test(id);
}

/**
 * The one value every entry agrees on (trimmed text), else undefined: an
 * absent or blank entry counts as a different value. Shared by conversion and
 * the legacy pin read, so "the set agrees" means one thing.
 */
export function agreed(values: unknown[]): string | undefined {
	const texts = new Set(values.map((value) => typeof value === 'string' && value.trim() ? value.trim() : null));
	if (texts.size !== 1) return undefined;
	return [...texts][0] ?? undefined;
}

/** The release identity a run uses, and where it came from. */
export interface MappingSetIdentity {
	mapping_set_id: string;
	id_origin: MappingSetIdOrigin;
}

/**
 * What a set already holds (M6b): its release id, origin, and version when a
 * record states one. `legacy` marks an id read from a set without a record:
 * such a set never stored a version, so no declared version can disagree with it.
 */
export type PinnedMappingSetIdentity = MappingSetIdentity & { mapping_set_version?: string; legacy?: true };

/** Every id Crosswalker minted, the old byte-hash form included, starts with this. */
const MINTED_ID_PREFIX = 'urn:crosswalker:mapping-set:';

/**
 * The identity for a run: the file's declared id; else the release
 * identity the set already holds (M6b: its record, else the id a legacy set
 * stamped); else a fresh mint. Reading a stamped value is not deriving.
 * Never derived from bytes, paths, rows or names.
 */
export function resolveMappingSetIdentity(header: SssomHeader, pinned?: MappingSetIdentity): MappingSetIdentity {
	const declared = normalizeMappingSetId(header.mapping_set_id);
	if (declared) return { mapping_set_id: declared, id_origin: 'declared' };
	if (pinned) return { mapping_set_id: pinned.mapping_set_id, id_origin: pinned.id_origin };
	return { mapping_set_id: mintMappingSetId(), id_origin: 'minted' };
}

function headerText(header: SssomHeader, key: string): string | undefined {
	const value = header[key];
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** SSSOM `creator_id`: a list, or one value. Empty entries are dropped. */
function creatorIds(value: unknown): string[] | undefined {
	const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
	const ids = list.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
	return ids.length ? ids : undefined;
}

/**
 * The record for one set from the source header and its rows. `identity`
 * defaults to `resolveMappingSetIdentity(header)`; a refresh passes the one it
 * resolved against the set's existing record.
 */
export function buildMappingSetRecord(
	header: SssomHeader,
	facts: Iterable<MappingSetAssertionFacts>,
	importSet: string | { id: string },
	identity: MappingSetIdentity = resolveMappingSetIdentity(header),
): MappingSetRecord {
	const record: Partial<MappingSetRecord> = { ...identity };
	for (const field of DECLARED_TEXT_FIELDS) {
		const value = headerText(header, field);
		if (value !== undefined) record[field] = value;
	}
	const creators = creatorIds(header.creator_id);
	if (creators) record.creator_id = creators;
	const license = headerText(header, 'license');
	if (license !== undefined) record.license = license;
	Object.assign(record, computeMappingSetDigests(facts));
	record.importSetId = typeof importSet === 'string' ? importSet : importSet.id;
	return record as MappingSetRecord;
}

// ---------------------------------------------------------------------------
// Refresh rule (M6)
// ---------------------------------------------------------------------------

function releaseText(id: string, version?: string): string {
	return version ? `release ${id} version ${version}` : `release ${id}`;
}

/**
 * Why a refresh must not write this file into the set holding `pinned`, or
 * null. A file that declares an id or version different from the record's is
 * a different release, and release isolation means a new set. A file that
 * declares nothing is compatible. Failure mode prevented: a refresh silently
 * turning one release into another inside the same set.
 */
export function mappingSetRefreshRefusal(
	pinned: { mapping_set_id: string; mapping_set_version?: string; legacy?: true } | undefined,
	header: SssomHeader,
): string | null {
	if (!pinned) return null;
	const declaredId = normalizeMappingSetId(header.mapping_set_id) || undefined;
	const declaredVersion = headerText(header, 'mapping_set_version');
	const idDiffers = declaredId !== undefined && declaredId !== pinned.mapping_set_id;
	const versionDiffers = declaredVersion !== undefined && !pinned.legacy && declaredVersion !== pinned.mapping_set_version;
	if (!idDiffers && !versionDiffers) return null;
	const fileId = declaredId ?? pinned.mapping_set_id;
	return `This file declares ${releaseText(fileId, declaredVersion)}. This set holds ${releaseText(pinned.mapping_set_id, pinned.mapping_set_version)}. Import it as a new set.`;
}

// ---------------------------------------------------------------------------
// Stored forms
// ---------------------------------------------------------------------------

/** The record as stored: `kind` first, then fields in schema order, no `importSetId`. */
export function storedMappingSet(record: MappingSetRecord): StoredMappingSet {
	const stored: StoredMappingSet = {
		kind: MAPPING_SET_KIND,
		mapping_set_id: record.mapping_set_id,
		id_origin: record.id_origin,
	};
	for (const field of DECLARED_TEXT_FIELDS) {
		if (record[field] !== undefined) stored[field] = record[field];
	}
	if (record.creator_id !== undefined) stored.creator_id = [...record.creator_id];
	if (record.license !== undefined) stored.license = record.license;
	stored.assertion_count = record.assertion_count;
	stored.membership_digest = record.membership_digest;
	stored.content_digest = record.content_digest;
	return stored;
}

/**
 * Read a stored record back, or throw an actionable error naming `where`. Only
 * the record's own fields are kept; user properties on a set note are ignored.
 */
export function mappingSetFromStored(stored: Record<string, unknown>, importSetId: string, where: string): MappingSetRecord {
	const fail = (detail: string): never => {
		throw new Error(`The release record in ${where} ${detail}. Import the set again to rewrite the record, or delete the record, then try again.`);
	};
	if (stored.kind !== MAPPING_SET_KIND) fail('is not marked as a mapping set release');
	const id = normalizeMappingSetId(stored.mapping_set_id);
	if (!id) fail('has no release id (property mapping_set_id)');
	if (stored.id_origin !== 'declared' && stored.id_origin !== 'minted') fail('does not say where its release id came from (property id_origin must be declared or minted)');
	const count = stored.assertion_count;
	if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) fail('has no valid mapping count (property assertion_count)');
	for (const key of ['membership_digest', 'content_digest'] as const) {
		if (typeof stored[key] !== 'string' || !DIGEST_PATTERN.test(stored[key] as string)) fail(`has no valid ${key === 'membership_digest' ? 'membership fingerprint' : 'content fingerprint'} (property ${key})`);
	}
	const record: Partial<MappingSetRecord> = {
		mapping_set_id: id,
		id_origin: stored.id_origin as MappingSetIdOrigin,
	};
	for (const field of DECLARED_TEXT_FIELDS) {
		const value = stored[field];
		if (value === undefined || value === null || value === '') continue;
		if (typeof value !== 'string' && typeof value !== 'number') fail(`has a ${field} that is not text`);
		record[field as DeclaredTextField] = String(value);
	}
	if (stored.creator_id !== undefined && stored.creator_id !== null) {
		const creators = creatorIds(stored.creator_id);
		if (creators) record.creator_id = creators;
	}
	if (stored.license !== undefined && stored.license !== null && stored.license !== '') record.license = String(stored.license);
	record.assertion_count = count as number;
	record.membership_digest = stored.membership_digest as string;
	record.content_digest = stored.content_digest as string;
	record.importSetId = importSetId;
	return record as MappingSetRecord;
}

/**
 * The `_crosswalker` block a set note carries: the block its set's mapping
 * notes carry (same ownership pins, so discovery reads one consistent set),
 * with a fresh `produced_at`. Row-level fingerprints are not copied.
 */
export function setNoteProvenance(edgeProvenance: Record<string, unknown>): Record<string, unknown> {
	const block: Record<string, unknown> = {};
	for (const key of ['spec_version', 'source_ref', 'produced_at', 'producer', 'recipe', 'import_set'] as const) {
		if (edgeProvenance[key] !== undefined) block[key] = edgeProvenance[key];
	}
	block.produced_at = new Date().toISOString();
	return block;
}

// ---------------------------------------------------------------------------
// Notes form: finding and writing the set note
// ---------------------------------------------------------------------------

export interface MappingSetNote {
	file: TFile;
	frontmatter: Record<string, unknown>;
}

/**
 * Every set note of `setId`, sorted by path, found by `kind` and the import set
 * id stamped in it, never by name. Cache first; a file the cache has not
 * indexed yet is read raw, but only inside `folder` (or `paths`), so the scan
 * never becomes a whole-vault content read. Cache lag is not absence.
 */
export async function findMappingSetNotes(
	app: App,
	setId: string,
	scope: { folder?: string | null; paths?: readonly string[] } = {},
): Promise<MappingSetNote[]> {
	return findSetNotesOfKind(app, setId, MAPPING_SET_KIND, scope);
}

/** The notes of `setId` whose `kind` is `kind`, found the way `findMappingSetNotes` finds set notes. */
async function findSetNotesOfKind(
	app: App,
	setId: string,
	kind: string,
	scope: { folder?: string | null; paths?: readonly string[] },
): Promise<MappingSetNote[]> {
	const base = scope.folder ? normalizeFolderSetting(scope.folder) : '';
	const listed = new Set(scope.paths ?? []);
	const inScope = (path: string) => listed.has(path) || (!!base && path.startsWith(`${base}/`));
	const found: MappingSetNote[] = [];
	const files = [...app.vault.getMarkdownFiles()].sort((a, b) => a.path.localeCompare(b.path));
	for (const file of files) {
		let fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!fm || Object.keys(fm).length === 0) {
			if (!inScope(file.path)) continue;
			const read = await readNoteFrontmatterState(app, file);
			if (read.state !== 'ok') continue;
			fm = read.frontmatter;
		}
		if (fm.kind !== kind) continue;
		if (importSetIdOf(fm._crosswalker) !== setId) continue;
		found.push({ file, frontmatter: fm });
	}
	return found;
}

/** The one set note of `setId` as a record, or undefined; two notes that disagree are refused. */
async function recordFromNotes(app: App, setId: string, scope: { folder?: string | null; paths?: readonly string[] }): Promise<MappingSetRecord | undefined> {
	const notes = await findMappingSetNotes(app, setId, scope);
	if (notes.length === 0) return undefined;
	const records = notes.map((note) => mappingSetFromStored(note.frontmatter, setId, note.file.path));
	const first = JSON.stringify(storedMappingSet(records[0]));
	const other = records.findIndex((record) => JSON.stringify(storedMappingSet(record)) !== first);
	if (other !== -1) {
		throw new Error(`Import set ${setId} has two different release records: ${notes[0].file.path} and ${notes[other].file.path}. Delete the one that is wrong, then try again.`);
	}
	return records[0];
}

/** The record a table header stores, or undefined when it stores none. */
export function mappingSetFromTableHeader(header: MappingTableHeader, setId: string, where: string): MappingSetRecord | undefined {
	if (header.mapping_set === undefined) return undefined;
	return mappingSetFromStored(header.mapping_set, setId, where);
}

/**
 * The release record of one import set, from whichever form the set uses, or
 * undefined for a set that has none (a set imported before records existed).
 * Never derives a record from rows.
 */
export async function readMappingSet(app: App, importSet: DiscoveredImportSet): Promise<MappingSetRecord | undefined> {
	if (importSet.mapping_form === 'table') {
		const owned = (await readMappingTables(app)).filter((table) => importSetIdOf(table.header.crosswalker_provenance) === importSet.id);
		if (owned.length !== 1) return undefined;
		return mappingSetFromTableHeader(owned[0].header, importSet.id, owned[0].path);
	}
	return recordFromNotes(app, importSet.id, { folder: importSet.root, paths: importSet.paths });
}

/**
 * The release identity a set already holds (M6b), for a refresh to keep. The
 * record when there is one; for a legacy set, the id its table header stamps,
 * or the id every one of its mapping notes agrees on. Undefined when a legacy
 * set yields no single id, and only then may a refresh mint. Reading a value
 * the set already stamped is not deriving one.
 */
export async function readPinnedMappingSetIdentity(app: App, existingSet: DiscoveredImportSet): Promise<PinnedMappingSetIdentity | undefined> {
	const record = await readMappingSet(app, existingSet);
	if (record) {
		return {
			mapping_set_id: record.mapping_set_id,
			id_origin: record.id_origin,
			...(record.mapping_set_version !== undefined ? { mapping_set_version: record.mapping_set_version } : {}),
		};
	}
	let id: string | undefined;
	if (existingSet.mapping_form === 'table') {
		const owned = (await readMappingTables(app)).filter((table) => importSetIdOf(table.header.crosswalker_provenance) === existingSet.id);
		if (owned.length === 1) id = normalizeMappingSetId(owned[0].header.mapping_set_id) || undefined;
	} else {
		const notes = await findSetNotesOfKind(app, existingSet.id, 'crosswalk-edge', { folder: existingSet.root, paths: existingSet.paths });
		if (notes.length) id = agreed(notes.map((note) => note.frontmatter.mapping_set_id));
	}
	if (!id) return undefined;
	return { mapping_set_id: id, id_origin: id.startsWith(MINTED_ID_PREFIX) ? 'minted' : 'declared', legacy: true };
}

/** Read the set note record of `setId` near `folder`, for writers that have no discovered set yet. */
export async function readMappingSetNoteRecord(app: App, setId: string, folder: string): Promise<MappingSetRecord | undefined> {
	return recordFromNotes(app, setId, { folder });
}

/** The file name stem of a set note: the title, else the local part of the id. */
function setNoteStem(record: MappingSetRecord): string {
	const title = record.mapping_set_title?.trim();
	if (title) {
		const stem = sanitizeFileName(title);
		if (stem) return stem;
	}
	const parts = record.mapping_set_id.split(/[/:#?=]+/).filter(Boolean);
	const local = sanitizeFileName(parts[parts.length - 1] ?? '');
	return local || 'Mapping set';
}

function bodyOf(content: string): string {
	const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
	return (match ? content.slice(match[0].length) : content).replace(/^\n+/, '');
}

/**
 * Write the set note of `record` in `folder`. An existing set note of the same
 * set is rewritten in place (wherever the user moved or renamed it), keeping its
 * body; otherwise a new note is created, named from the title or the id's local
 * part, taking ` 2`, ` 3`... when that name is taken. Returns its path.
 */
export async function writeMappingSetNote(
	app: App,
	input: { folder: string; record: MappingSetRecord; provenance: Record<string, unknown> },
): Promise<string> {
	const frontmatter = { ...storedMappingSet(input.record), _crosswalker: input.provenance };
	const existing = await findMappingSetNotes(app, input.record.importSetId, { folder: input.folder });
	if (existing.length > 0) {
		const [note, ...extra] = existing;
		const current = await app.vault.read(note.file);
		await app.vault.modify(note.file, buildNoteContent(frontmatter, bodyOf(current)));
		for (const duplicate of extra) await app.vault.trash(duplicate.file, false);
		return note.file.path;
	}
	const folder = normalizeFolderSetting(input.folder);
	if (folder && !app.vault.getAbstractFileByPath(folder)) {
		try { await app.vault.createFolder(folder); } catch { /* already present on disk */ }
	}
	const stem = setNoteStem(input.record);
	const pathFor = (n: number) => `${folder ? `${folder}/` : ''}${n > 1 ? `${stem} ${n}` : stem}.md`;
	let n = 1;
	while (app.vault.getAbstractFileByPath(pathFor(n))) n += 1;
	const path = pathFor(n);
	await app.vault.create(path, buildNoteContent(frontmatter, ''));
	return path;
}

// ---------------------------------------------------------------------------
// Observed participants (M7)
// ---------------------------------------------------------------------------

/**
 * The endpoint curie prefixes the rows actually use, sorted. Shown labelled
 * "observed from rows" when a record declares no subject or object source;
 * never written into a record.
 */
export function observedParticipants(rows: Iterable<{ subject_id: string; object_id: string }>): { subjectPrefixes: string[]; objectPrefixes: string[] } {
	const subjects = new Set<string>();
	const objects = new Set<string>();
	const prefix = (curie: string) => {
		const index = curie.indexOf(':');
		return index > 0 ? curie.slice(0, index) : null;
	};
	for (const row of rows) {
		const subject = prefix(String(row.subject_id));
		const object = prefix(String(row.object_id));
		if (subject) subjects.add(subject);
		if (object) objects.add(object);
	}
	return { subjectPrefixes: [...subjects].sort(), objectPrefixes: [...objects].sort() };
}
