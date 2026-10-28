/**
 * A command line import keeps the recipe copy for its set, and `cw export
 * --format csv` reads that copy back to rebuild the source columns. The import
 * uses the detected recipe, which is never saved to the library, so the copy is
 * the only place the export can find it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Papa from 'papaparse';
import { runCli } from '../../cli/crosswalker';
import { REPO, captureIo, installByteFile, readTree, tempDir } from './helpers';

installByteFile();

const SOURCE = path.join(REPO, 'tools/fixtures/synthetic/nist-mini.csv');
const DESTINATION = 'Frameworks/NIST-mini';

describe('cw import keeps the recipe copy for its set', () => {
	it('writes the copy and exports the source columns from it', async () => {
		const vault = tempDir('recipe-copy');
		const imported = captureIo();
		expect(await runCli(['import', '--vault', vault, '--source', SOURCE, '--ontology', 'nist-mini',
			'--destination', DESTINATION, '--deterministic'], imported.io)).toBe(0);
		expect(imported.err).toEqual([]);

		const copies = [...readTree(vault).keys()].filter((p) => p.startsWith('_crosswalker/import-sets/'));
		expect(copies).toHaveLength(1);
		expect(copies[0]).toMatch(/^_crosswalker\/import-sets\/iset-[0-9a-f]+\/recipe-sha256-[0-9a-f]{64}\.json$/);

		const out = path.join(tempDir('recipe-copy-out'), 'export.csv');
		const exported = captureIo();
		expect(await runCli(['export', '--vault', vault, '--folder', DESTINATION, '--format', 'csv', '--out', out], exported.io)).toBe(0);
		expect(exported.err).toEqual([]);

		const source = Papa.parse<Record<string, string>>(fs.readFileSync(SOURCE, 'utf8'), { header: true, skipEmptyLines: true });
		const back = Papa.parse<Record<string, string>>(fs.readFileSync(out, 'utf8'), { header: true, skipEmptyLines: true });
		// Every source column is either rebuilt or named in the report with a reason.
		const report = exported.out.join('\n');
		for (const column of source.meta.fields ?? []) {
			if (!back.meta.fields?.includes(column)) expect(report).toContain(`Not included: ${column} `);
		}
		expect(back.meta.fields).toEqual(expect.arrayContaining(['id', 'description']));
		expect(back.data).toHaveLength(source.data.length);
		// Rebuilt cells carry the source values, row for row by id.
		const byId = new Map(back.data.map((r) => [r.id, r]));
		for (const row of source.data) expect(byId.get(row.id)?.description).toBe(row.description);
	}, 60000);
});
