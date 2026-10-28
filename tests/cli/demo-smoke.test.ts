/**
 * Demo smoke: `bun run demo:build` produces a vault that validates, has the
 * expected folders, and carries no licensed content.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCli } from '../../cli/crosswalker';
import { REPO, captureIo, installByteFile, readTree, tempDir } from './helpers';

installByteFile();

const RESTRICTED = /(_licensed|\bcri\b|cri-profile|iso[-_ ]?27|\biso\b|soc[-_ ]?2|\bpci\b|\bcis\b|cis-controls|\bscf\b)/i;

describe('demo:build', () => {
	const out = path.join(tempDir('demo'), 'vault');
	let result: ReturnType<typeof spawnSync>;

	beforeAll(() => {
		result = spawnSync('bun', ['scripts/demo-build.mjs', '--out', out], { cwd: REPO, encoding: 'utf8' });
	}, 240000);

	it('finishes and prints a manifest', () => {
		expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
		expect(result.stdout).toContain('all valid');
		expect(result.stdout).toMatch(/notes in total, \d+ bytes on disk/);
	});

	it('has the frameworks, both link sets, evidence, queries and the start note', () => {
		for (const folder of [
			'Frameworks/NIST-CSF-2.0', 'Frameworks/NIST-SP-800-53-r5', 'Frameworks/MITRE-ATT&CK',
			'_crosswalker/mappings/csf-to-800-53', '_crosswalker/mappings/csf-to-mitre',
			'Evidence/Documents', 'Evidence/Junctions', 'Queries',
		]) {
			expect({ folder, exists: fs.existsSync(path.join(out, folder)) }).toEqual({ folder, exists: true });
		}
		expect(fs.existsSync(path.join(out, 'Start here.md'))).toBe(true);
		const evidence = fs.readdirSync(path.join(out, 'Evidence/Junctions'));
		expect(evidence.length).toBeGreaterThanOrEqual(3);
		expect(evidence.length).toBeLessThanOrEqual(5);
		const bases = fs.readdirSync(path.join(out, 'Queries')).filter((f) => f.endsWith('.base'));
		expect(bases.length).toBeGreaterThanOrEqual(4);
	});

	it('validates with cw validate', async () => {
		const { io, err } = captureIo();
		expect(await runCli(['validate', '--vault', out], io)).toBe(0);
		expect(err).toEqual([]);
	}, 60000);

	it('targets the queries at the demo set ids', () => {
		const ids = [...result.stdout.matchAll(/Set id: (iset-[a-z0-9]+)\./g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThanOrEqual(6);
		const coverage = fs.readFileSync(path.join(out, 'Queries/CSF to 800-53 coverage.base'), 'utf8');
		expect(coverage).toMatch(/csf-to-800-53|iset-/);
	});

	// The demo exists to show mappings joining real framework notes. A link set
	// whose ends point at notes the vault does not have reads as empty in Obsidian.
	// The few CSF to 800-53 rows that stay unresolved name a family, a category,
	// or a control newer than the catalog, so they are source gaps, not bugs.
	it('resolves mapping links to framework notes at both ends', () => {
		const resolved = (folder: string) => {
			let total = 0;
			let both = 0;
			for (const name of fs.readdirSync(path.join(out, folder)).filter((f) => f.endsWith('.md'))) {
				const text = fs.readFileSync(path.join(out, folder, name), 'utf8');
				const ends = ['subject_note', 'object_note'].map(
					(key) => new RegExp(`^${key}: "\\[\\[([^|\\]]+)`, 'm').exec(text)?.[1],
				);
				if (ends.every((e) => e === undefined)) continue;
				total++;
				if (ends.every((e) => e !== undefined && fs.existsSync(path.join(out, `${e}.md`)))) both++;
			}
			return { total, both };
		};
		const nist = resolved('_crosswalker/mappings/csf-to-800-53');
		expect(nist.total).toBeGreaterThan(700);
		expect(nist.both / nist.total).toBeGreaterThan(0.98);
		const mitre = resolved('_crosswalker/mappings/csf-to-mitre');
		expect(mitre).toEqual({ total: mitre.total, both: mitre.total });
		expect(mitre.total).toBeGreaterThan(0);
	});

	it('carries no licensed content or restricted framework names', () => {
		for (const [p, bytes] of readTree(out)) {
			const folders = p.split('/').slice(0, -1).join('/');
			expect({ p, restricted: RESTRICTED.test(folders) }).toEqual({ p, restricted: false });
			expect({ p, licensed: bytes.toString('utf8').includes('_licensed') }).toEqual({ p, licensed: false });
		}
	});
});
