import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { parseSssomTsv } from '../../src/import/sssom-parser';
import { mappingResolution, publicCsv } from './demo-public-sources';
import type { MappingRows } from './stack-mapping-readers';

export interface StackImport {
	id: string;
	label: string;
	source: string;
	destination: string;
	setId?: string;
}
export type FrameworkImport = StackImport & { graphKey: string; describe?: string };
export type MappingImport = StackImport & { derived?: MappingRows };

interface Frontmatter {
	[key: string]: unknown;
	_crosswalker?: { import_set?: { id?: string; ontology?: string } };
}
interface Note { file: string; frontmatter: Frontmatter }

function readNotes(out: string, relative = ''): Note[] {
	const notes: Note[] = [];
	for (const entry of fs.readdirSync(path.join(out, relative), { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const file = path.posix.join(relative, entry.name);
		if (entry.isDirectory()) notes.push(...readNotes(out, file));
		else if (entry.name.endsWith('.md')) {
			const text = fs.readFileSync(path.join(out, file), 'utf8');
			const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
			if (!match) continue;
			const frontmatter = yaml.load(match[1]);
			if (frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)) notes.push({ file, frontmatter: frontmatter as Frontmatter });
		}
	}
	return notes;
}

const linkTarget = (value: unknown) => typeof value === 'string' && /^\[\[([^|\]]+)/.exec(value)?.[1];
const ownNote = (note: Note, item: StackImport) => item.destination
	? note.file.startsWith(`${item.destination}/`)
	: note.frontmatter._crosswalker?.import_set?.id === item.setId && item.setId !== undefined;

/** Take a snapshot for the source report and the generated welcome bullets. */
export function sourceSummary(out: string, frameworks: FrameworkImport[], mappings: MappingImport[]) {
	const notes = readNotes(out);
	const concepts = notes.filter(({ frontmatter: fm }) => typeof fm.curie === 'string' && !['crosswalk-edge', 'mapping-set', 'junction-note'].includes(String(fm.kind)));
	const identities = new Set(concepts.flatMap(({ frontmatter: fm }) => {
		const curie = fm.curie;
		const ontology = fm._crosswalker?.import_set?.ontology;
		return typeof curie === 'string' ? [curie, ...(ontology ? [`${ontology}:${curie.slice(curie.indexOf(':') + 1)}`] : [])] : [];
	}));
	return {
		frameworks: frameworks.map((framework) => {
			const own = concepts.filter((note) => ownNote(note, framework));
			const links = own.filter((note) => note.frontmatter.parent);
			const parentResolved = links.filter((note) => {
				const fm = note.frontmatter;
				if (typeof fm.parent_curie === 'string' && identities.has(fm.parent_curie)) return true;
				const target = linkTarget(fm.parent);
				return target && (fs.existsSync(path.join(out, `${target}.md`)) || fs.existsSync(path.join(out, path.dirname(note.file), `${target}.md`)));
			}).length;
			const catalog = framework.graphKey === 'd3fend' ? publicCsv(fs.readFileSync(framework.source, 'utf8')) : null;
			return { framework, counts: { notesCreated: own.length, parents: links.length, parentResolved,
				...(framework.graphKey === 'attack' ? { techniques: own.filter((note) => !String(note.frontmatter.technique_id).includes('.')).length,
					subTechniques: own.filter((note) => String(note.frontmatter.technique_id).includes('.')).length } : {}),
				...(catalog ? { depths: ['D3FEND Technique', 'D3FEND Technique Level 0', 'D3FEND Technique Level 1'].map((key) => catalog.filter((row) => row[key]?.trim()).length) } : {}),
			} };
		}),
		mappings: mappings.map((mapping) => {
			const own = notes.filter((note) => ownNote(note, mapping) && note.frontmatter.kind === 'crosswalk-edge');
			const resolved = (key: string) => own.filter((note) => {
				const target = linkTarget(note.frontmatter[key]);
				return target && fs.existsSync(path.join(out, `${target}.md`));
			}).length;
			const subjectLinksResolved = resolved('subject_note');
			const objectLinksResolved = resolved('object_note');
			const rows = mapping.derived?.rows ?? (/\.sssom\.tsv$/i.test(mapping.source) ? parseSssomTsv(fs.readFileSync(mapping.source, 'utf8')).rows : null);
			const notesCounts = { notesCreated: own.length, subjectLinksResolved, objectLinksResolved };
			return { mapping, counts: rows ? {
				rowsRead: mapping.derived?.rowsRead ?? rows.length, duplicatesSkipped: mapping.derived?.duplicatesSkipped ?? 0,
				emptyRows: mapping.derived?.emptyRows ?? 0, filteredRows: mapping.derived?.filteredRows ?? 0, nonMappableRows: mapping.derived?.nonMappableRows ?? 0,
				importerRowsCollapsed: rows.length - own.length, ...notesCounts, ...mappingResolution(rows, identities),
			} : notesCounts };
		}),
	};
}

export function manifest(out: string, checkFolder?: (folder: string) => void) {
	const perFolder = new Map<string, number>();
	let bytes = 0;
	let notes = 0;
	const walk = (dir: string, visible: boolean) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const included = visible && !entry.name.startsWith('.');
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				checkFolder?.(path.relative(out, full));
				if (included || checkFolder) walk(full, included);
				continue;
			}
			if (!included) continue;
			bytes += fs.statSync(full).size;
			if (!entry.name.endsWith('.md')) continue;
			notes++;
			const folder = path.relative(out, dir).split(path.sep).join('/') || '(vault root)';
			perFolder.set(folder, (perFolder.get(folder) ?? 0) + 1);
		}
	};
	walk(out, true);
	return { perFolder, bytes, notes };
}
