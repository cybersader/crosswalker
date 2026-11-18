import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import schema from '../../spec/stack.schema.json';

export const RESTRICTED = /(_licensed|\bcri\b|cri-profile|iso[-_ ]?27|\biso\b|soc[-_ ]?2|\bpci\b|\bcis\b|cis-controls|\bscf\b)/i;

/** These are the named sources each reader takes, not arbitrary arguments. */
export const READER_INPUTS = {
	'ctid-json': ['bundle'],
	'd3fend-controls': ['catalog', 'table'],
	'd3fend-attack-mitigations': ['table'],
	'olir-workbook': ['workbook'],
} as const;
export type Reader = keyof typeof READER_INPUTS;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Fields = Record<string, JsonValue>;
type Step<K extends string> = { kind: K; id: string };

export type ImportStep = Step<'import'> & {
	label: string; source: string; recipe?: string; sheet?: string; headerRow?: number;
	destination?: string; role: 'framework' | 'mapping' | 'evidence'; describe?: string; graphKey?: string;
};
export type DerivedStep = Step<'derived-mappings'> & {
	reader: Reader; label: string; destination: string; provider: string; from: string; to: string;
	release: string; inputs: Record<string, string>; when?: string;
};
export type LicenseStep = Step<'license'> & {
	folder: string; publisher: string; url: string; file: string; when?: string;
} & ({ style: 'terms' } | { style: 'wrapped-md'; name: string; shortName: string; license: string });

export type StackStep = ImportStep | DerivedStep | LicenseStep
	| (Step<'note'> & { path: string; frontmatter: Fields; body: string })
	| (Step<'set-fields'> & { folder: string; files: string[]; fields: Fields })
	| (Step<'query'> & { path: string; template: string; params: Fields })
	| (Step<'start-here'> & { path: string; lines: string[] })
	| (Step<'graph'> & { path: string })
	| Step<'report'>;

export interface StackFile {
	stack: 'v0'; id: string; label: string; description: string; public: boolean;
	requires: string[]; steps: StackStep[]; guard?: { emptyOrMarker: string };
}

export class StackFileError extends Error {}
let validateSchema: ValidateFunction<StackFile> | undefined;

function schemaProblem(error: ErrorObject | undefined): string {
	if (!error) return 'The stack has an unexpected shape. Check it against spec/stack.schema.json.';
	const where = error.instancePath || 'The stack';
	if (error.keyword === 'enum' && where.endsWith('/kind')) {
		return `Unknown step kind at ${where}. Choose one of: ${schema.$defs.step.properties.kind.enum.join(', ')}.`;
	}
	if (error.keyword === 'enum' && where.endsWith('/reader')) {
		return `Unknown mapping reader at ${where}. Choose one of: ${Object.keys(READER_INPUTS).join(', ')}.`;
	}
	if (error.keyword === 'additionalProperties') {
		return `Unexpected field "${String(error.params.additionalProperty)}" at ${where}. Remove it or check the spelling against spec/stack.schema.json.`;
	}
	return `${where} ${error.message ?? 'is invalid'}. Fix it using spec/stack.schema.json.`;
}

function relativePath(value: string): void {
	if (/[\\:\p{Cc}]/u.test(value) || value.split('/').some((part) => !part || /[. ]$/.test(part))) {
		throw new StackFileError(`Invalid stack path ${JSON.stringify(value)}. Use a relative path with forward slashes, no parent segments, and no trailing dots or spaces.`);
	}
}

export function checkPublicSource(value: string): void {
	if (RESTRICTED.test(value)) {
		throw new StackFileError(`Refusing ${value}: public stacks use public-domain, openly licensed or synthetic content only. Choose a public source or use a private stack.`);
	}
}

export function checkPublicFolder(folder: string): void {
	if (RESTRICTED.test(folder)) {
		throw new StackFileError(`The vault has a folder named "${folder}", which looks like licensed content. Remove its source from the build.`);
	}
}

export function isRecipePath(recipe: string): boolean {
	return /[/\\:]|\.json$/i.test(recipe);
}

/** Substitute only whole-value references; human-written Markdown is literal. */
export function queryParams(params: Fields, resolve: (id: string) => string): Fields {
	const substitute = (value: JsonValue): JsonValue => {
		if (typeof value === 'string') {
			const ref = /^\{set:([^{}]*)\}$/.exec(value);
			return ref ? resolve(ref[1]) : value;
		}
		if (Array.isArray(value)) return value.map(substitute);
		if (value && typeof value === 'object') return queryParams(value, resolve);
		return value;
	};
	return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, substitute(value)]));
}

/** Validate the disk format, then references and paths that span fields or steps. */
export function validateStackFile(value: unknown): StackFile {
	validateSchema ??= new Ajv2020().compile<StackFile>(schema);
	if (!validateSchema(value)) throw new StackFileError(schemaProblem(validateSchema.errors?.[0]));
	const earlier = new Map<string, StackStep>();
	const source = (file: string) => {
		relativePath(file);
		if (value.public) checkPublicSource(file);
	};
	const folder = (file: string) => {
		relativePath(file);
		if (value.public) checkPublicFolder(file);
	};
	const output = (file: string) => {
		relativePath(file);
		const slash = file.lastIndexOf('/');
		if (slash !== -1) folder(file.slice(0, slash));
	};
	const requireEarlierSet = (from: string, id: string, mappingOnly = false) => {
		const step = earlier.get(id);
		if (step?.kind !== 'derived-mappings' && !(step?.kind === 'import' && (!mappingOnly || step.role === 'mapping'))) {
			throw new StackFileError(`Step "${from}" references "${id}" but it is not an earlier ${mappingOnly ? 'mapping' : 'import or derived mapping'} step. Correct the id or move the referenced step earlier.`);
		}
		return id;
	};
	value.requires.forEach(source);
	for (const step of value.steps) {
		if (earlier.has(step.id)) throw new StackFileError(`Duplicate step id "${step.id}". Give every step a different id and update any references.`);
		switch (step.kind) {
			case 'import':
				source(step.source);
				if (step.recipe && isRecipePath(step.recipe)) source(step.recipe);
				if (step.destination && step.destination !== '.') folder(step.destination);
				break;
			case 'derived-mappings': {
				folder(step.destination);
				const names: readonly string[] = READER_INPUTS[step.reader];
				const keys = Object.keys(step.inputs);
				if (keys.length !== names.length || keys.some((key) => !names.includes(key))) {
					throw new StackFileError(`Reader "${step.reader}" needs these named inputs: ${names.join(', ')}. Update inputs on step "${step.id}".`);
				}
				Object.values(step.inputs).forEach(source);
				if (step.when) {
					if (step.reader !== 'olir-workbook') throw new StackFileError(`Step "${step.id}" uses adds-pairs-over with the wrong reader. Remove when or use olir-workbook.`);
					requireEarlierSet(step.id, step.when.slice('adds-pairs-over:'.length), true);
				}
				break;
			}
			case 'set-fields':
				folder(step.folder);
				step.files.forEach((file) => output(`${step.folder}/${file}`));
				break;
			case 'license':
				folder(step.folder);
				source(step.file);
				if (step.when) requireEarlierSet(step.id, step.when.slice('set:'.length));
				break;
			case 'query':
				output(step.path);
				queryParams(step.params, (id) => requireEarlierSet(step.id, id));
				break;
			case 'note':
			case 'start-here':
			case 'graph':
				output(step.path);
				break;
		}
		earlier.set(step.id, step);
	}
	if (value.guard) {
		const marker = value.guard.emptyOrMarker;
		if (marker.includes('/') || !value.steps.some((step) => (step.kind === 'note' || step.kind === 'start-here') && step.path === marker)) {
			throw new StackFileError('The replacement marker must be a root note written by this stack. Give guard.emptyOrMarker the path of a note or start-here step, or remove the guard.');
		}
	}
	return value;
}

export function loadStackFile(file: string): StackFile {
	let contents: string;
	try {
		contents = readFileSync(file, 'utf8');
	} catch {
		throw new StackFileError(`Could not read stack file "${file}". Check the path and file permissions, then try again.`);
	}
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch {
		throw new StackFileError(`Stack file "${file}" is not valid JSON. Fix its syntax, then try again.`);
	}
	return validateStackFile(value);
}
