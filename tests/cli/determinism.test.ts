/**
 * Determinism: the same `cw import --deterministic` commands on the same
 * committed fixtures write byte-identical trees, set ids included.
 */
import * as path from 'node:path';
import { runCli, DETERMINISTIC_FIRST_SET_ID, DETERMINISTIC_PRODUCED_AT } from '../../cli/crosswalker';
import { REPO, captureIo, installByteFile, readTree, tempDir } from './helpers';

installByteFile();

const STEPS: string[][] = [
	['--source', path.join(REPO, 'tools/fixtures/synthetic/nist-mini.csv'), '--ontology', 'nist-mini', '--destination', 'Frameworks/NIST-mini'],
	['--source', path.join(REPO, 'tools/fixtures/realistic/nist-csf-2.0-govern-identify.csv'), '--ontology', 'nist-csf-2', '--destination', 'Frameworks/NIST-CSF-2.0'],
	['--source', path.join(REPO, 'tools/fixtures/realistic/nist-csf-to-mitre-attack.sssom.tsv'), '--destination', '_crosswalker/mappings/csf-to-mitre'],
	['--source', path.join(REPO, 'tools/fixtures/demo/evidence-links.csv'), '--recipe', 'evidence-junction-notes', '--destination', '.'],
];

async function build(label: string): Promise<{ tree: Map<string, Buffer>; out: string[] }> {
	const vault = tempDir(label);
	const all: string[] = [];
	for (const step of STEPS) {
		const { io, out, err } = captureIo();
		const code = await runCli(['import', '--vault', vault, ...step, '--deterministic'], io);
		const errors = err.filter((line) => !line.startsWith('warning: '));
		expect({ step: step[1], code, errors }).toEqual({ step: step[1], code: 0, errors: [] });
		all.push(...out, ...err);
	}
	return { tree: readTree(vault), out: all };
}

describe('cw import --deterministic', () => {
	it('writes byte-identical trees on two runs', async () => {
		const first = await build('det-a');
		const second = await build('det-b');
		expect([...second.tree.keys()].sort()).toEqual([...first.tree.keys()].sort());
		for (const [p, bytes] of first.tree) {
			expect({ p, same: second.tree.get(p)?.equals(bytes) }).toEqual({ p, same: true });
		}
		expect(second.out).toEqual(first.out);

		// The pinned values the spec names.
		expect(first.out[0]).toContain(`Set id: ${DETERMINISTIC_FIRST_SET_ID}.`);
		const sample = [...first.tree].find(([p]) => p.startsWith('Frameworks/NIST-mini/'))![1].toString('utf8');
		expect(sample).toContain(`produced_at: "${DETERMINISTIC_PRODUCED_AT}"`);
		// Successive sets in one vault get distinct ids.
		const ids = first.out.map((line) => /Set id: (iset-[a-z0-9]+)\./.exec(line)?.[1]).filter(Boolean);
		expect(new Set(ids).size).toBe(STEPS.length);
	}, 120000);

	it('restores the real clock after a run', async () => {
		const vault = tempDir('det-clock');
		await runCli(['import', '--vault', vault, ...STEPS[0], '--deterministic'], captureIo().io);
		expect(new Date().toISOString()).not.toBe(DETERMINISTIC_PRODUCED_AT);
	}, 60000);
});
