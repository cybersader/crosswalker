import type { SssomRow } from '../sssom-parser';
import { injectiveDeclaredIdLocalPart, injectiveEndpointToken, slugifyForCurie } from '../../generation/curie';
import { normalizeMappingId } from './licensed-workbook-readers';
import type { Recipe } from '../../render';

export interface CrosswalkColumn {
	column: string;
	label: string;
	/** Pinned by the caller, not inferred on later refreshes. */
	ontology: string;
}
export interface ReferencedIdentifier {
	id: string;
	framework: string;
	file_id: string;
}

/** The fixed header-to-key rule. The manifest keeps its result as a literal. */
export function referencedOntologyKey(header: string): string {
	return slugifyForCurie(header.normalize('NFKD').replace(/[̀-ͯ]/g, ''));
}

/**
 * A publisher column is a list of identifiers, not prose or inferred relations.
 * Reusable with a wide workbook or a normalized long-form catalog column.
 * The same identity encoder as generation preserves spaces, slashes and punctuation
 * without collapsing distinct ids. Filename safety is deliberately separate.
 */
export function referencedFramework(
	rows: readonly Record<string, string>[],
	binding: CrosswalkColumn,
	source: { idColumn: string; ontology: string },
): { notes: ReferencedIdentifier[]; mappings: SssomRow[]; assertions: number; duplicates: number; missingSubjects: number } {
	const identifiers = new Map<string, ReferencedIdentifier>();
	const mappings: SssomRow[] = [];
	const seen = new Set<string>();
	let assertions = 0, duplicates = 0, missingSubjects = 0;
	for (const row of rows) {
		const subject = row[source.idColumn]?.trim();
		for (const id of (row[binding.column] ?? '').split(/\r\n|\r|\n/).map((value) => value.trim()).filter(Boolean)) {
			assertions++;
			if (!subject) { missingSubjects++; continue; }
			const endpoint = (ontology: string, raw: string): string => {
				const normalized = normalizeMappingId(`${ontology}:${raw}`).slice(ontology.length + 1);
				return `${ontology}:${injectiveDeclaredIdLocalPart(normalized)}`;
			};
			const subject_id = endpoint(source.ontology, subject);
			const object_id = endpoint(binding.ontology, id);
			const key = JSON.stringify([subject_id, object_id]);
			if (seen.has(key)) { duplicates++; continue; }
			seen.add(key);
			identifiers.set(object_id, { id, framework: binding.label, file_id: injectiveEndpointToken(id) });
			mappings.push({ subject_id, object_id, predicate_id: 'skos:relatedMatch', mapping_justification: 'semapv:ManualMappingCuration' });
		}
	}
	return { notes: [...identifiers.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), mappings, assertions, duplicates, missingSubjects };
}

/**
 * No persistent top-level marker/tag: those would survive a full import as user
 * fields. The graph selects this recipe's replaced provenance instead. A full
 * refresh chooses this exact set and keeps its destination to preserve links.
 */
export function referencedFrameworkRecipe(ontology: string, sourceLabel: string): Recipe {
	return {
		recipe: 'cw-referenced-framework',
		source: { ontology, levels: ['identifier'] },
		target: {
			layout: [{ level: 'identifier', mechanism: 'file', template: '{file_id|fs-safe}.md' }],
			also_emit: {
				frontmatter: { managed: { id: '{id}', title: '{id}', framework: '{framework}' }, user_preserve: ['reviewer', 'status', 'notes'] },
				body: [{ position: 'append', template: `Only the identifier is known here. It comes from ${sourceLabel}'s crosswalk; import the full framework to see its text.` }],
			},
		},
	};
}
