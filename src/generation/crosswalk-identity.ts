import { injectiveEndpointToken } from './curie';
import type { ImportSetReference } from './import-set';

export type CrosswalkIdentitySetReference = Pick<
	ImportSetReference,
	'id' | 'scheme' | 'derivation'
>;

/** The identity space for every newly minted crosswalk edge. */
export const SSSOM_CURIE_PREFIX = 'sssom';

/** The derivation every newly minted crosswalk import set records. */
export const CURRENT_CROSSWALK_DERIVATION = 'declared-facts-v1';

/** The frozen identity-space prefix carried by pre-SSSOM crosswalk edges. */
export const LEGACY_XWALK_CURIE_PREFIX = 'xwalk';

/**
 * Stable CURIE local-part for one crosswalk edge, dispatched by the active set's
 * pinned scheme and derivation. The ontology pair is deliberately absent: it is
 * data about the assertion, not the identity space that contains it.
 */
export function sssomEdgeCurie(
	row: Record<string, unknown>,
	importSet: CrosswalkIdentitySetReference,
): string {
	const sanitize = importSet.derivation === CURRENT_CROSSWALK_DERIVATION
		? injectiveEndpointToken
		: legacySanitizeCuriePart;
	const subj = sanitize(String(row.subject_id ?? 'unknown'));
	const obj = sanitize(String(row.object_id ?? 'unknown'));
	if (importSet.scheme === 'endpoint-v1') return `cw-${subj}-${obj}`;
	if (importSet.scheme === 'set-qualified-v1') return `cwset-${importSet.id}-${subj}-${obj}`;
	const exhaustive: never = importSet.scheme;
	throw new Error(`Unsupported import set scheme: ${String(exhaustive)}.`);
}

/**
 * `filename-stem-v1` only. Frozen because existing sets already carry this
 * many-to-one endpoint form.
 */
function legacySanitizeCuriePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}
