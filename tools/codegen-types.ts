#!/usr/bin/env bun
/**
 * codegen-types.ts — generate TypeScript types from spec/*.schema.json
 *
 * Run via `bun run codegen`. Outputs into src/types/generated/, which is
 * committed to git so reviewers can see the schema impact in PR diffs.
 * Pass `--check` to fail when committed output differs from a fresh generation.
 *
 * Per the v0.1.1 milestone: spec/ schemas are the load-bearing contract;
 * the plugin code consumes typed structures generated from those schemas
 * rather than hand-maintained TS interfaces. When schemas change,
 * re-run this and commit the generated diff.
 */

import { compile } from 'json-schema-to-typescript';
import type { JSONSchema4 } from 'json-schema';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const SPEC_DIR = join(REPO_ROOT, 'spec');
const OUT_DIR = join(REPO_ROOT, 'src', 'types', 'generated');
const CHECK_ONLY = process.argv.includes('--check');

const SPECS = [
	{ schema: 'tier1.schema.json', out: 'tier1.ts' },
	{ schema: 'recipe.schema.json', out: 'recipe.ts' },
];

type SchemaObject = Record<string, any>;

/**
 * json-schema-to-typescript collapses the canonical layout_entry's conditional
 * constraints (`if mechanism=heading then level_depth`, `if variadic then
 * mechanism=folder`) to `unknown`. For code generation only, expand those same
 * constraints into an equivalent five-way oneOf. Runtime validation still uses
 * the canonical schema unchanged; this adapter only gives TypeScript the useful
 * discriminated union already present in the JSON Schema semantics.
 */
function prepareForCodegen(schema: SchemaObject, filename: string): SchemaObject {
	const prepared = JSON.parse(JSON.stringify(schema)) as SchemaObject;
	if (filename !== 'recipe.schema.json') return prepared;

	const defs = prepared.$defs as SchemaObject | undefined;
	const layout = defs?.layout_entry as SchemaObject | undefined;
	const mechanisms = defs?.mechanism?.enum as string[] | undefined;
	if (!layout?.properties || !layout.required || !mechanisms) {
		throw new Error('recipe.schema.json layout_entry/mechanism shape changed; update codegen adapter.');
	}

	const commonProperties = layout.properties as SchemaObject;
	layout.oneOf = mechanisms.map((mechanism) => {
		const properties = JSON.parse(JSON.stringify(commonProperties)) as SchemaObject;
		properties.mechanism = { type: 'string', const: mechanism };
		if (mechanism !== 'folder') delete properties.variadic;

		const required = [...layout.required] as string[];
		if (mechanism === 'heading' && !required.includes('level_depth')) required.push('level_depth');

		return {
			type: 'object',
			title: `${mechanism[0].toUpperCase()}${mechanism.slice(1)} layout entry`,
			required,
			additionalProperties: false,
			properties,
		};
	});
	delete layout.type;
	delete layout.required;
	delete layout.additionalProperties;
	delete layout.properties;
	delete layout.allOf;

	expandSourceJoinForCodegen(defs);

	return prepared;
}

/**
 * Same treatment, same reason, for $defs/source_join: its `if cardinality=many
 * then select is required and has exactly one item` collapses to `unknown` in
 * json-schema-to-typescript, which would erase the whole join surface from the
 * generated types. Expand it into the equivalent two-way oneOf so TypeScript
 * sees the discriminated union the JSON Schema semantics already describe.
 * Runtime validation still uses the canonical schema unchanged.
 */
function expandSourceJoinForCodegen(defs: SchemaObject | undefined): void {
	const join = defs?.source_join as SchemaObject | undefined;
	const from = defs?.source_join_from as SchemaObject | undefined;
	if (!join?.properties || !join.allOf || !from?.properties) {
		throw new Error('recipe.schema.json source_join/source_join_from shape changed; update codegen adapter.');
	}
	const properties = join.properties as SchemaObject;
	const required = join.required as string[];

	// `from`'s own `oneOf: [required sheet | required iterator]` collapses the
	// same way. Expanding it also lets the generated type carry the runtime rule
	// that header_row belongs to a sheet and never to an iterator.
	const fromProps = from.properties as SchemaObject;
	from.oneOf = [
		{
			type: 'object',
			title: 'Secondary sheet',
			required: ['sheet'],
			additionalProperties: false,
			properties: { sheet: fromProps.sheet, header_row: fromProps.header_row, where: fromProps.where },
		},
		{
			type: 'object',
			title: 'Secondary iterator',
			required: ['iterator'],
			additionalProperties: false,
			properties: { iterator: fromProps.iterator, where: fromProps.where },
		},
	];
	delete from.type;
	delete from.additionalProperties;
	delete from.properties;

	const variant = (cardinality: 'one' | 'many'): SchemaObject => {
		const props = JSON.parse(JSON.stringify(properties)) as SchemaObject;
		props.cardinality = { type: 'string', const: cardinality };
		if (cardinality === 'many') props.select = { ...(props.select as SchemaObject), maxItems: 1 };
		return {
			type: 'object',
			title: cardinality === 'one' ? 'Single-match join' : 'Multi-match join',
			required: cardinality === 'many' ? [...required, 'select'] : [...required],
			additionalProperties: false,
			properties: props,
		};
	};

	join.oneOf = [variant('one'), variant('many')];
	delete join.type;
	delete join.required;
	delete join.additionalProperties;
	delete join.properties;
	delete join.allOf;
}

/** Fail generation if contract-critical recipe surfaces disappear from output. */
function assertRecipeTypeCoverage(ts: string): void {
	const required = [
		'export type LayoutEntry =',
		"mechanism: 'folder'",
		"mechanism: 'file'",
		"mechanism: 'heading'",
		"mechanism: 'tag'",
		"mechanism: 'wikilink'",
		"kind?: 'concept' | 'junction-note' | 'crosswalk-edge'",
		'variadic?:',
		'managed_links?:',
		'user_preserve?:',
		'enrichment?:',
		'metadata?:',
		'based_on?:',
		'version?: string;',
		'body?:',
		'query?: QueryBlock;',
		'graph_edges?: GraphEdge[];',
		"linkStyle?: 'absolute' | 'shortest';",
		'where?: RowPredicate;',
		'joins?: KeyedLookupEnrichment;',
		"cardinality: 'one'",
		"cardinality: 'many'",
	];
	const missing = required.filter((needle) => !ts.includes(needle));
	if (missing.length > 0) {
		throw new Error(`Generated recipe types lost contract coverage: ${missing.join(', ')}`);
	}
}

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	let drift = false;

	for (const { schema, out } of SPECS) {
		const inputPath = join(SPEC_DIR, schema);
		const outputPath = join(OUT_DIR, out);
		console.log(`  ${schema} → src/types/generated/${out}`);

		const source = JSON.parse(await readFile(inputPath, 'utf8')) as SchemaObject;
		const prepared = prepareForCodegen(source, schema);
		const ts = await compile(prepared as JSONSchema4, source.title ?? 'GeneratedSchema', {
			bannerComment: `/**\n * THIS FILE IS AUTO-GENERATED by tools/codegen-types.ts.\n * Source: spec/${schema}\n * Do NOT edit by hand. Re-run \`bun run codegen\` after schema changes.\n */`,
			style: { singleQuote: true, useTabs: true },
		});
		if (schema === 'recipe.schema.json') assertRecipeTypeCoverage(ts);

		if (CHECK_ONLY) {
			const committed = await readFile(outputPath, 'utf8').catch(() => '');
			if (committed !== ts) {
				drift = true;
				console.error(`  DRIFT: src/types/generated/${out}`);
			}
		} else {
			await writeFile(outputPath, ts);
		}
	}

	if (CHECK_ONLY && drift) {
		throw new Error('Generated type drift detected. Run `bun run codegen` and commit the result.');
	}
	console.log(`\n${CHECK_ONLY ? 'Checked' : 'Generated'} ${SPECS.length} files in src/types/generated/`);
}

main().catch((err) => {
	console.error('Code generation failed:', err);
	process.exit(1);
});
