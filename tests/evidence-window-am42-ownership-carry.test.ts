/**
 * evidence-window-am42-ownership-carry.test.ts — AM-42 (2026-09-02, pass 15,
 * Task C item 2): the window carries ownership; it never writes it.
 *
 * THE DEFECT THIS PINS (pass-14 CONFIRMED 2). `_crosswalker` was
 * `WINDOW_MANAGED_KEYS`, and the window's own `buildEvidenceLink` call never
 * passes `importSet`, so the fresh block it built carried NO `import_set`. On
 * update, the managed-keys merge replaced the note's `_crosswalker` block
 * wholesale, stripping the junction's ownership stamp. The next refresh of the
 * recipe that created that junction then read `stamp.importSetId === null`,
 * missed it in the owned identity index, fell through to the address branch,
 * and refused the row with "an earlier import that carries no import set. Move
 * or delete that note." Approving a link through the window made its own
 * recipe unable to refresh it, and the offered remedy was to delete the
 * reviewed note.
 *
 * THE RULE. `_crosswalker` left `WINDOW_MANAGED_KEYS`: on an UPDATE the note's
 * whole block — `import_set`, producer, spec_version, everything — is carried
 * BYTE-FOR-BYTE. On a CREATE the window still emits its own block (a
 * window-minted junction belongs to no import set, which is a true fact about
 * it). `tags` follows the list-union rule (mirrors `frontmatter-merge.ts`'s
 * `LIST_UNION_KEYS`): a removed `evidence/junction` tag is restored, a user's
 * added tag survives.
 */

import { TFile, TFolder } from 'obsidian';
import { EvidenceLinkModal, type ControlCandidate } from '../src/views/evidence-link-modal';
import { evidenceLinkCurie, evidenceLinkPath } from '../src/views/evidence-link';
import type { App } from 'obsidian';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

function makeVault() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
			// S5 (2026-09-04) fix follow-up: buildLinkFallbackIndex reads getFiles(),
			// not getMarkdownFiles() -- a stub missing it throws the moment a scan
			// falls back to the vault file list. No non-markdown fixture here, so this
			// answers the same set; see tests/vault-path-normalization-s5.test.ts for
			// the PDF/non-markdown case.
			getFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (text === undefined) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				try { return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> }; }
				catch { return { frontmatter: undefined }; }
			},
			getFirstLinkpathDest: () => null,
		},
		workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
	};
	return { app: app as unknown as App, files };
}

const FOLDER = 'Evidence/Junctions';
const EVIDENCE = 'Evidence/MFA policy.md';
const CONTROL: ControlCandidate = {
	path: 'Frameworks/NIST/AC-2.md',
	title: 'AC-2',
	curie: 'nist:AC-2',
	reviewCid: null,
};
const LINK_PATH = evidenceLinkPath(FOLDER, CONTROL.curie, CONTROL.path, EVIDENCE);
const LINK_CURIE = evidenceLinkCurie(CONTROL.curie, CONTROL.path, EVIDENCE);

interface ModalInternals {
	control: ControlCandidate | null;
	evidencePath: string;
	resolvePair(control: ControlCandidate, evidencePath: string): Promise<void>;
	create(): Promise<void>;
}

async function press(app: App): Promise<void> {
	const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
	modal.control = CONTROL;
	modal.evidencePath = EVIDENCE;
	await modal.resolvePair(CONTROL, EVIDENCE);
	await modal.create();
}

const fmTextOf = (text: string): string =>
	/^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
const fmOf = (text: string): Record<string, unknown> => (yaml.load(fmTextOf(text)) ?? {}) as Record<string, unknown>;

/** A junction the RECIPE minted: owned by an import set, carrying full provenance. */
function ownedJunction(tags: string[]): string {
	const tagsLine = tags.length > 0 ? `tags: [${tags.join(', ')}]` : 'tags: []';
	return [
		'---',
		`curie: ${LINK_CURIE}`,
		'kind: junction-note',
		`subject: "[[${CONTROL.path}|AC-2]]"`,
		`subject_curie: "${CONTROL.curie}"`,
		'predicate: has_evidence',
		`object: "[[${EVIDENCE}|MFA policy]]"`,
		'coverage: full',
		'status: proposed',
		tagsLine,
		'_crosswalker:',
		'  spec_version: "https://crosswalker.dev/spec/tier1.schema.json"',
		'  producer: "bulk-recipe/1.0"',
		'  import_set:',
		'    id: iset-recipe-owned',
		'---',
		'',
		'# AC-2 has evidence: MFA policy',
		'',
	].join('\n');
}

describe('AM-42: the window carries _crosswalker on update; it never writes it', () => {
	it('import_set.id survives an update BYTE-FOR-BYTE', async () => {
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');
		files.set(LINK_PATH, ownedJunction(['evidence/junction']));

		await press(app);

		const fm = fmOf(files.get(LINK_PATH)!);
		const provenance = fm._crosswalker as Record<string, unknown>;
		expect(provenance.import_set).toEqual({ id: 'iset-recipe-owned' });
		expect(provenance.producer).toBe('bulk-recipe/1.0');
		expect(provenance.spec_version).toBe('https://crosswalker.dev/spec/tier1.schema.json');
	});

	it('the note stays FINDABLE by its owning recipe: the raw text carries the set id', async () => {
		// The precise failure mode: `stamp.importSetId === null` after the window
		// touched the note, because the block was replaced wholesale. Asserted on
		// the raw bytes too, not only the parsed value, since that is what
		// `buildOwnedHubValueIndex`'s stamp reader actually reads off disk.
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');
		files.set(LINK_PATH, ownedJunction(['evidence/junction']));

		await press(app);

		expect(files.get(LINK_PATH)).toContain('id: iset-recipe-owned');
	});

	it('a CREATE (window-minted junction) still carries no import_set — a true fact about it', async () => {
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');
		// Nothing seeded at LINK_PATH: this is a fresh mint.

		await press(app);

		const fm = fmOf(files.get(LINK_PATH)!);
		const provenance = fm._crosswalker as Record<string, unknown> | undefined;
		expect(provenance?.import_set).toBeUndefined();
	});

	it('a removed evidence/junction tag is RESTORED by the update', async () => {
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');
		// The tag was hand-deleted; only an unrelated tag remains.
		files.set(LINK_PATH, ownedJunction(['someone/removed-the-tag']));

		await press(app);

		const fm = fmOf(files.get(LINK_PATH)!);
		expect(fm.tags).toContain('evidence/junction');
	});

	it('a user-added tag SURVIVES the update alongside the restored one', async () => {
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');
		files.set(LINK_PATH, ownedJunction(['evidence/junction', 'quarterly-audit']));

		await press(app);

		const fm = fmOf(files.get(LINK_PATH)!);
		expect(fm.tags).toEqual(expect.arrayContaining(['evidence/junction', 'quarterly-audit']));
		// De-duplicated, not doubled.
		expect((fm.tags as string[]).filter((t) => t === 'evidence/junction')).toHaveLength(1);
	});
});
