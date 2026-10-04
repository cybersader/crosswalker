/**
 * evidence-workflow-roundtrip.test.ts — the loop has to actually close
 * (2026-08-21).
 *
 * Every other test in this area checks one link in the chain. This one checks
 * that the chain joins up: a link created by the command, parsed as real YAML,
 * projected into the index, is COUNTED by the coverage query and disappears
 * from the gap list.
 *
 * It exists because that join is precisely where the previous attempt failed.
 * The recipe, the Base, and the guide were each internally coherent, and each
 * described a different contract, so evidence created one way was invisible to
 * a report reading another. Unit tests on either side would all have passed.
 */

import { applyMigrations } from '../src/tier2/migrations';
import { projectFromTier1 } from '../src/tier2/projector';
import { buildEvidenceLink } from '../src/views/evidence-link';
import {
	conceptsWithoutValidEvidence,
	diagnoseExcludedJunctions,
	evidenceCoverageSummary,
} from '../src/tier2/evidence-coverage';

const { DatabaseSync } = require('node:sqlite');
const yaml = require('js-yaml') as { load: (s: string) => unknown };

interface ExecOptions {
	sql: string;
	bind?: Record<string, unknown>;
	rowMode?: 'array';
	returnValue?: 'resultRows';
}
interface TestDb { exec(input: string | ExecOptions): unknown[][] | void; close(): void }

function createTestDb(): TestDb {
	const sqlite = new DatabaseSync(':memory:');
	return {
		exec(input) {
			if (typeof input === 'string') { sqlite.exec(input); return; }
			const statement = sqlite.prepare(input.sql);
			if (input.rowMode === 'array') statement.setReturnArrays(true);
			const bind = input.bind ?? {};
			if (input.returnValue === 'resultRows') return Object.keys(bind).length ? statement.all(bind) : statement.all();
			if (Object.keys(bind).length) statement.run(bind); else statement.run();
		},
		close: () => sqlite.close(),
	};
}

/** Parse the frontmatter of a generated note the way Obsidian would. */
function frontmatterOf(markdown: string): Record<string, unknown> {
	const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
	if (!match) throw new Error('generated note has no frontmatter block');
	return yaml.load(match[1]) as Record<string, unknown>;
}

const provenance = {
	spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
	source_ref: { file: 'source.csv' },
	produced_at: '2026-08-21T00:00:00.000Z',
};

/** A vault of [path, frontmatter] pairs, as the projector consumes it. */
function mockApp(entries: Array<[string, Record<string, unknown>]>): any {
	const files = entries.map(([path]) => ({ path, stat: { mtime: 0 } }));
	const byPath = new Map(entries);
	return {
		vault: { getMarkdownFiles: () => files },
		metadataCache: { getFileCache: (file: { path: string }) => ({ frontmatter: byPath.get(file.path) }) },
	};
}

const CONTROL_PATH = 'Frameworks/NIST/AC-2.md';
const CONTROL_CURIE = 'nist-800-53:AC-2';

const controlNote: Record<string, unknown> = {
	curie: CONTROL_CURIE,
	title: 'AC-2 Account Management',
	_crosswalker: provenance,
};

/** Build a link, parse it, and hand both notes to the projector. */
function projectWith(db: TestDb, linkOverrides: Parameters<typeof buildEvidenceLink>[0]) {
	const note = buildEvidenceLink(linkOverrides);
	const fm = frontmatterOf(note.markdown);
	// Junction notes need provenance to be projected, exactly as generated ones do.
	fm._crosswalker = provenance;
	return projectFromTier1(
		mockApp([[CONTROL_PATH, controlNote], [note.path, fm]]),
		db as any,
		{ projectionMode: 'full' },
	);
}

const linkInput = {
	controlPath: CONTROL_PATH,
	controlCurie: CONTROL_CURIE,
	evidencePath: 'Evidence/MFA policy.md',
	coverage: 'full' as const,
	status: 'approved' as const,
	folder: 'Evidence/Junctions',
};

describe('a link created by the command is counted by the report', () => {
	let db: TestDb;
	beforeEach(async () => { db = createTestDb(); await applyMigrations(db as any); });
	afterEach(() => db.close());

	it('closes the gap it was created to close', async () => {
		// Before: the control is a gap.
		await projectFromTier1(mockApp([[CONTROL_PATH, controlNote]]), db as any, { projectionMode: 'full' });
		expect(await conceptsWithoutValidEvidence(db, 'nist-800-53')).toHaveLength(1);

		// After: the same control is covered, with nothing set aside.
		await projectWith(db, linkInput);
		expect(await conceptsWithoutValidEvidence(db, 'nist-800-53')).toHaveLength(0);
		expect(await diagnoseExcludedJunctions(db)).toHaveLength(0);

		const summary = await evidenceCoverageSummary(db, 'nist-800-53');
		expect(summary.covered).toBe(1);
		expect(summary.excluded_junctions).toBe(0);
	});

	it('counts a partial link as partial, not as covered', async () => {
		await projectWith(db, { ...linkInput, coverage: 'partial' });
		const summary = await evidenceCoverageSummary(db, 'nist-800-53');
		expect(summary.partial).toBe(1);
		expect(summary.covered).toBe(0);
	});

	it('does not count the modal default until it is approved, and says why', async () => {
		// The modal defaults to `proposed`, so this is the first thing most
		// users will produce. It must not silently count, and the reason it
		// does not must be discoverable.
		await projectWith(db, { ...linkInput, status: 'proposed' });
		expect(await conceptsWithoutValidEvidence(db, 'nist-800-53')).toHaveLength(1);
		expect((await diagnoseExcludedJunctions(db))[0].reason).toBe('not-approved');
	});

	it('does not count a link that records non-coverage', async () => {
		await projectWith(db, { ...linkInput, coverage: 'none' });
		expect(await conceptsWithoutValidEvidence(db, 'nist-800-53')).toHaveLength(1);
		expect((await diagnoseExcludedJunctions(db))[0].reason).toBe('coverage-not-asserted');
	});

	it('reports a link to an unimported control as unresolvable rather than counting it', async () => {
		await projectWith(db, { ...linkInput, controlCurie: 'nist-800-53:NOT-IMPORTED' });
		expect(await conceptsWithoutValidEvidence(db, 'nist-800-53')).toHaveLength(1);
		expect((await diagnoseExcludedJunctions(db))[0].reason).toBe('subject-not-a-known-concept');
	});

	it('records the index freshness the report will quote', async () => {
		// The report reads this stamp; if projection stopped writing it, every
		// report would silently downgrade to "freshness unknown".
		const { readProjectionStatus } = await import('../src/tier2/projector');
		await projectWith(db, linkInput);
		const status = await readProjectionStatus(db);
		expect(status.lastProjectedAt).not.toBeNull();
		expect(status.mode).toBe('full');
		expect(status.succeeded).toBe(true);
	});
});
