/**
 * mapping/facets.ts — derive a row's facet memberships from an ImportMapping.
 *
 * A facet is a level whose destinations include a `tag` primitive (spec §7c). The
 * enrichment pass (src/generation/enrich.ts) materializes one hub note per facet
 * VALUE, so it needs, per row, the (namespace, raw value) pairs that row belongs
 * to. This helper reads them straight off the mapping + row — the same source the
 * tag templates are built from — so hub display names keep their original casing
 * (`Access Control`, not the tagsafe `access-control`).
 *
 * Pure module: NO Obsidian imports.
 */

import type { ImportMapping, Destination, LevelSource } from './types';
import { isConstantRef, toSourceRefs } from './types';
import { parseTemplateSegments, renderTagTemplate, renderTemplate } from '../../render/template';
import type { Recipe } from '../../render';

/**
 * Canonical tag templates are the membership authority for every entry point.
 * Keep the display value before tagsafe, while using the same split/filter
 * grammar as rendering. Do not reverse a lossy tag slug into a concept title.
 */
export function deriveRecipeFacetMemberships(recipe: Recipe, row: Record<string, unknown>): FacetMembership[] {
	const out: FacetMembership[] = [];
	const seen = new Set<string>();
	for (const template of recipe.target.also_emit?.tags ?? []) {
		const segments = parseTemplateSegments(template);
		// A facet value follows the final namespace slash outside interpolations.
		let boundary = -1;
		let raw = '';
		for (const segment of segments) {
			if (segment.kind === 'lit') {
				const slash = segment.text.lastIndexOf('/');
				if (slash >= 0) boundary = raw.length + slash;
				raw += segment.text;
			} else {
				const interp = segment.interp;
				raw += `{${interp.rawPath}${interp.filters.filter((filter) => filter.name !== 'tagsafe').map((filter) => `|${filter.raw}`).join('')}}`;
			}
		}
		if (boundary < 0) continue;
		const prefix = renderTemplate(raw.slice(0, boundary + 1), row);
		for (const tag of renderTagTemplate(raw, row)) {
			const namespace = prefix.slice(0, -1).replace(/^#+/, '');
			const value = tag.slice(prefix.length).trim();
			const key = JSON.stringify([namespace, value]);
			if (!namespace || !value || seen.has(key)) continue;
			seen.add(key);
			out.push({ namespace, value });
		}
	}
	return out;
}

/** One facet a row belongs to: a tag namespace + the raw (display) cell value. */
export interface FacetMembership {
	/** Tag namespace (the facet's column-slug, e.g. `control-family`). */
	namespace: string;
	/** Raw cell value, original casing (e.g. `Access Control`). */
	value: string;
}

/** Common list separators for multi-value facet cells. */
const LIST_DELIMITERS = [',', ';'];

/**
 * Every facet membership a row belongs to, across all tag destinations in the
 * mapping. Multi-value cells (`a, b`) split into several memberships. Deterministic:
 * mappings walked in order, values in cell order. Empty cells contribute nothing.
 */
export function deriveFacetMemberships(mapping: ImportMapping, row: Record<string, unknown>): FacetMembership[] {
	const out: FacetMembership[] = [];
	for (const structure of mapping.mappings) {
		for (const level of structure.levels) {
			const tagDest = level.destinations.find((d): d is Extract<Destination, { primitive: 'tag' }> => d.primitive === 'tag');
			if (!tagDest) continue;
			const column = firstColumn(level.source);
			const namespace = tagDest.namespace ?? slug(column);
			const raw = row[column];
			for (const piece of splitMultiValue(raw)) {
				out.push({ namespace, value: piece });
			}
		}
	}
	return out;
}

/** First column referenced by a level source (constants contribute their literal). */
function firstColumn(source: LevelSource): string {
	const ref = toSourceRefs(source)[0];
	return isConstantRef(ref) ? ref.constant : ref.column;
}

/** Split a cell on list delimiters, trim, drop empties. */
function splitMultiValue(value: unknown): string[] {
	let pieces = [String(value ?? '')];
	for (const d of LIST_DELIMITERS) pieces = pieces.flatMap((p) => p.split(d));
	return pieces.map((p) => p.trim()).filter((p) => p !== '');
}

/** Slug a column name into a tag namespace (mirrors detection.tagRoot / serialize.slug). */
function slug(column: string): string {
	return column
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
