/**
 * import-set-s6-destination-normalization.test.ts -- S6 ruling (2026-09-04,
 * pass 16 ruling, implemented pass 17, Task C item 5): a stamped import-set
 * destination is read through the SAME normalization the AM-53 accessor uses,
 * not a second, weaker spelling of it.
 *
 * THE DEFECT THIS PINS. `normalizeFolder` was `value.trim().replace(/^\/+|\/+$/g,
 * '')` -- trim plus edge FORWARD-slash stripping, a fraction of one of the
 * host's four `normalizePath` mutations (it also folds backslashes to forward
 * slashes, collapses internal `//`, folds NBSP/NFD, and normalizes to NFC).
 * The recorded destination was compared, via that partial normalization,
 * against fully host-normalized vault paths (`resolveSetRoot`'s
 * `paths.every((path) => path.startsWith(`${recorded}/`))`) -- the question
 * "where does this set live". A destination stamped with a backslash (a
 * Windows-style path pasted or typed once, before AM-49 started normalizing
 * every SETTING at the boundary -- but a raw `destination` value written
 * straight from a recipe or an older Crosswalker build carries the same risk)
 * failed that comparison and silently fell through to the SEGMENT-WISE
 * recovery fallback, which recovers a DIFFERENT (and, when the recorded root
 * sits ABOVE where the notes happen to nest, a WRONG -- too deep) folder.
 *
 * THE RULE. `normalizeFolder` is now `normalizeOutputRoot` -- the exact AM-53
 * function, not a second copy of it -- so the comparison succeeds on the
 * ordinary case and `resolveSetRoot` returns the RECORDED root directly,
 * without ever reaching the fallback. `recoverImportSetRoot` itself, and the
 * degrade path that reaches it, are UNCHANGED (this pins that they still fire
 * when nothing was recorded, or when the recorded root genuinely disagrees
 * with the notes).
 */

import { TFile } from 'obsidian';
import { discoverImportSets, recoverImportSetRoot } from '../src/generation/import-set';
import type { App } from 'obsidian';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

function makeApp(files: Map<string, string>): App {
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (text === undefined) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: {} };
				try { return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> }; }
				catch { return { frontmatter: {} }; }
			},
		},
	};
	return app as unknown as App;
}

const note = (frontmatterYaml: string): string => `---\n${frontmatterYaml}\n---\nBody.\n`;

/** One import-set observation, as it lands on disk. */
function stamped(opts: { curie: string; destination: string; ontology?: string }): string {
	const lines = [
		`curie: "${opts.curie}"`,
		`ontology: "${opts.ontology ?? 'nist'}"`,
		'_crosswalker:',
		'  import_set:',
		'    id: "iset-ab12cd"',
		'    scheme: "endpoint-v1"',
		// Single-quoted YAML: backslash is LITERAL, no escaping needed. This is
		// the pre-AM-49 shape a destination could carry: a Windows-style
		// separator and a trailing one, neither of which the OLD
		// trim-plus-forward-slash normalizeFolder touched at all.
		`    destination: '${opts.destination}'`,
	];
	return note(lines.join('\n'));
}

describe('S6: a stamped destination normalizes through the SAME accessor AM-53 uses, so it matches its own notes', () => {
	it('a backslash-separated, trailing-backslash destination is normalized and taken DIRECTLY -- never falls through to the (wrong, too-deep) segment-recovery fallback', async () => {
		const files = new Map<string, string>();
		// True recorded root: Frameworks. The recipe's own layout nests one
		// level deeper (a framework-name folder under it), so segment-wise
		// recovery of these two notes' common ancestor gives Frameworks/NIST --
		// SHALLOWER than nothing, but DEEPER (wrong) relative to the true root.
		files.set('Frameworks/NIST/Persistence/AC-1.md', stamped({ curie: 'nist:AC-1', destination: 'Frameworks\\' }));
		files.set('Frameworks/NIST/Discovery/T1.md', stamped({ curie: 'nist:T1', destination: 'Frameworks\\' }));

		const app = makeApp(files);
		const sets = await discoverImportSets(app, undefined);
		expect(sets).toHaveLength(1);

		// Sanity check on the premise: segment-wise recovery of these two paths
		// really does disagree with the true recorded root. If this assertion
		// itself failed, the test above would prove nothing about which route
		// resolveSetRoot took.
		expect(recoverImportSetRoot([...files.keys()])).toBe('Frameworks/NIST');

		// The recorded destination, read back NORMALIZED -- no trailing
		// backslash survives.
		expect(sets[0].destination).toBe('Frameworks');
		// And `root` took the RECORDED value directly -- the shallow, correct
		// one -- not the fallback's too-deep guess.
		expect(sets[0].root).toBe('Frameworks');
		expect(sets[0].root).not.toBe('Frameworks/NIST');
	});

	it('control: with NO destination recorded at all, the segment-wise fallback still runs and still answers correctly -- S6 does not touch the degrade path', async () => {
		const files = new Map<string, string>();
		const lines = [
			'curie: "nist:AC-1"',
			'_crosswalker:',
			'  import_set:',
			'    id: "iset-ef34gh"',
			'    scheme: "endpoint-v1"',
			// No destination field at all -- an import written before AM-49/AM-53,
			// or by a producer that never stamped one.
		];
		files.set('Frameworks/NIST/AC-1.md', note(lines.join('\n')));
		files.set('Frameworks/NIST/AC-2.md', note(lines.join('\n').replace('AC-1', 'AC-2')));

		const app = makeApp(files);
		const sets = await discoverImportSets(app, undefined);
		expect(sets).toHaveLength(1);
		expect(sets[0].destination).toBeUndefined();
		expect(sets[0].root).toBe('Frameworks/NIST'); // recovered from the notes themselves
	});

	it('control: a recorded destination that genuinely disagrees with where the notes now sit (a hand-moved folder) still fails closed to the fallback, not to a stale answer', async () => {
		const files = new Map<string, string>();
		// Stamped root says Frameworks, but every note actually lives under a
		// DIFFERENT folder now -- a genuine disagreement, not a normalization gap.
		files.set('Moved/Elsewhere/AC-1.md', stamped({ curie: 'nist:AC-1', destination: 'Frameworks' }));
		files.set('Moved/Elsewhere/AC-2.md', stamped({ curie: 'nist:AC-2', destination: 'Frameworks' }));

		const app = makeApp(files);
		const sets = await discoverImportSets(app, undefined);
		expect(sets).toHaveLength(1);
		// The recorded value round-trips as read (still normalized)...
		expect(sets[0].destination).toBe('Frameworks');
		// ...but `root` did NOT trust it, because the notes disagree with it.
		expect(sets[0].root).toBe('Moved/Elsewhere');
	});
});
