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

	it('carries no licensed content or restricted framework names', () => {
		for (const [p, bytes] of readTree(out)) {
			const folders = p.split('/').slice(0, -1).join('/');
			expect({ p, restricted: RESTRICTED.test(folders) }).toEqual({ p, restricted: false });
			expect({ p, licensed: bytes.toString('utf8').includes('_licensed') }).toEqual({ p, licensed: false });
		}
	});
});
