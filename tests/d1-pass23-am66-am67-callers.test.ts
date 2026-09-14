/**
 * d1-pass23-am66-am67-callers.test.ts — AM-66 and AM-67 (2026-09-04): every
 * direct `enrich()` caller states its write set, and the amendments that
 * re-pointed behaviour are cited where the behaviour lives.
 *
 * AM-65 made `writeSet` required rather than optional, because without it every
 * kept row would describe its own folder — a caller that omits it is not asking
 * a narrower question, it is asking a wrong one. AM-66 then found that a refusal
 * which "counted six callers" actually had thirteen. So this file does not trust
 * a count written down anywhere: it ENUMERATES the call sites from the tree and
 * checks each one, and it reports the number it found rather than asserting a
 * number someone remembered.
 *
 * WHY THIS DOES NOT GREP. `src/generation/enrich.ts` contains literal NUL bytes
 * (a `\0` list separator and a `\x00-\x1f` regex character class). `file`
 * reports it as `data`, git marks it `-text`, and PLAIN `grep` silently returns
 * nothing for it — a survey that greps this file without `-a` concludes a symbol
 * is absent when it is present. Node's `fs.readFileSync` has no such behaviour,
 * and the first assertion below proves the NUL bytes are actually there, so a
 * future reader can tell a real absence from a silent one.
 *
 * WHY THIS IS PER-CALL-SITE. Checking that the token `writeSet` appears
 * somewhere in a file that also calls `enrich()` proves nothing: one call site
 * out of nine could omit it. Each call's own argument text is extracted by
 * paren balancing and checked on its own.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { enrich, type EnrichNote } from '../src/generation/enrich';

const REPO = join(__dirname, '..');
const ENRICH_MODULE = join(REPO, 'src/generation/enrich.ts');

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (full.endsWith('.ts')) out.push(full);
	}
	return out;
}

/** Comments only — string literals are left alone so argument text stays intact. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Does this file import the `enrich` function from the enrichment module? */
function importsEnrich(source: string): boolean {
	const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*\/enrich['"]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		if (m[1].split(',').some((s) => s.trim() === 'enrich')) return true;
	}
	return false;
}

interface RawCall { args: string; after: string }

/**
 * The balanced argument text of every direct `enrich(...)` call in a file, plus
 * the text that follows it (so a call whose whole point is to be REFUSED can be
 * told from one that forgot). `enrich()` with empty parens is prose — it turns
 * up inside test names and message strings — and is not a call site.
 */
function enrichCalls(source: string): RawCall[] {
	const out: RawCall[] = [];
	const re = /(?<![\w.$])enrich\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		let depth = 0;
		let i = m.index + m[0].length - 1;
		const start = i + 1;
		for (; i < source.length; i++) {
			if (source[i] === '(') depth++;
			else if (source[i] === ')') {
				depth--;
				if (depth === 0) break;
			}
		}
		const args = source.slice(start, i);
		if (args.trim() === '') continue;
		out.push({ args, after: source.slice(i, i + 300) });
	}
	return out;
}

interface CallSite { file: string; args: string; provesRefusal: boolean }

function allEnrichCallSites(): CallSite[] {
	const sites: CallSite[] = [];
	for (const file of [...walk(join(REPO, 'src')), ...walk(join(REPO, 'tests'))]) {
		if (file === ENRICH_MODULE) continue; // the definition, not a caller
		if (file === __filename.replace(/\.js$/, '.ts')) continue; // this file's own examples
		const raw = readFileSync(file, 'utf8');
		if (!importsEnrich(raw)) continue;
		for (const call of enrichCalls(stripComments(raw))) {
			sites.push({
				file: relative(REPO, file),
				args: call.args,
				// A site that exists to prove the refusal omits the set ON PURPOSE.
				provesRefusal: /\.toThrow|\.rejects/.test(call.after),
			});
		}
	}
	return sites;
}

describe('AM-66: every direct enrich() caller states its write set', () => {
	it('the enrichment module really does carry NUL bytes, so a silent grep is not mistaken for an absence', () => {
		const bytes = readFileSync(ENRICH_MODULE);
		expect(bytes.includes(0)).toBe(true);
		// And this reader can still see the module's exported symbol.
		expect(bytes.toString('utf8')).toContain('export function enrich(');
	});

	it('enumerated from the tree, every call site names writeSet', () => {
		const sites = allEnrichCallSites();
		// Enumerated, not remembered: a call site that appears without being counted
		// is exactly the failure AM-66 recorded. Thirteen is the number pass 22
		// measured; more is fine, fewer means the enumeration stopped seeing files.
		expect(sites.length).toBeGreaterThanOrEqual(13);
		const silent = sites
			.filter((s) => !s.provesRefusal && !/\bwriteSet\b/.test(s.args))
			.map((s) => `${s.file}: enrich(${s.args.replace(/\s+/g, ' ').slice(0, 120)})`);
		expect(silent).toEqual([]);
		// And the deliberate omissions really are deliberate: at least one site
		// exists whose whole purpose is the refusal.
		expect(sites.some((s) => s.provesRefusal)).toBe(true);
	});

	it('and the call sites are spread across more than one file, so the enumeration is not one file\'s habit', () => {
		const files = new Set(allEnrichCallSites().map((s) => s.file));
		expect(files.size).toBeGreaterThanOrEqual(10);
		// The one production caller is among them.
		expect([...files]).toContain('src/generation/generation-engine.ts');
	});

	it('AM-65: omitting the write set is refused by name, not silently defaulted', () => {
		const note: EnrichNote = { path: 'Frameworks/A/T1.md', curie: 'x:t1', frontmatter: {}, facets: [] };
		expect(() => enrich([note], {
			ontology: 'x',
			config: { children_lists: true, facet_notes: 'none', level_hubs: 'notes' },
			rootFolder: 'Frameworks',
			// writeSet deliberately absent.
		} as never)).toThrow(/writeSet is required/);
	});
});

describe('AM-78/AM-79: the amendments are cited where the behaviour they rule actually lives', () => {
	const source = readFileSync(ENRICH_MODULE, 'utf8');

	it('AM-78 is cited at the recorded-chain narrowing it ratifies, not merely somewhere in the file', () => {
		const guard = source.indexOf('observed.hasRecordedChain');
		expect(guard).toBeGreaterThan(-1);
		// The citation is in the comment block immediately above the condition.
		const preamble = source.slice(Math.max(0, guard - 2500), guard);
		expect(preamble).toContain('AM-78');
	});

	it('AM-79 is cited at the state-`one` sentence it assigns to S18, and the sentence is unchanged', () => {
		const cite = source.indexOf('AM-79');
		expect(cite).toBeGreaterThan(-1);
		// The comment sits immediately above the arm it rules, and the sentence
		// itself is the very next thing in the file.
		const block = source.slice(cite, cite + 1800);
		expect(block).toContain('its recorded identity could not be read');
		// The owner AM-79 names, so a later re-point has a fixed address to move from.
		expect(block).toContain('d1-pass20-s17-s18-address-and-withheld.test.ts');
		// And the arm it rules is the state-`one` one, not the folder-level
		// `unreadable` arm AM-68 deleted.
		expect(block).toContain("observed?.state === 'one'");
	});
});
