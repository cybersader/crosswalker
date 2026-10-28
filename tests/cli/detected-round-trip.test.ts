/**
 * An import with no recipe or ontology uses the detected recipe. Exporting the
 * set back to CSV rebuilds every source column in the source's own order, and a list of links comes back
 * joined with the delimiter the source used, not a default comma.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Papa from 'papaparse';
import { runCli } from '../../cli/crosswalker';
import { captureIo, installByteFile, tempDir } from './helpers';

installByteFile();

// Columns deliberately out of the order a detected recipe references them.
const SOURCE = [
	'group,id,related,description,parent,name',
	'G,G-1,G-2;G-3,Keep a list of assets.,,Inventory',
	'G,G-2,G-1;G-4,Name an owner for each asset.,G-1,Ownership',
	'G,G-3,G-4,Review the list each quarter.,G-1,Review',
	'G,G-4,,Remove assets that are no longer used.,,Retire',
	'H,H-1,H-2;G-1,Back up data on a schedule.,,Backups',
	'H,H-2,H-1,Test that backups restore.,H-1,Restore tests',
	'',
].join('\n');

describe('cw import with the detected recipe round trips through CSV export', () => {
	it('rebuilds every column in source order and keeps the semicolon list delimiter', async () => {
		const dir = tempDir('detected-round-trip');
		const source = path.join(dir, 'source.csv');
		fs.writeFileSync(source, SOURCE);
		const vault = path.join(dir, 'vault');
		fs.mkdirSync(vault);

		const imported = captureIo();
		expect(await runCli(['import', '--vault', vault, '--source', source, '--destination', 'F', '--deterministic'], imported.io)).toBe(0);
		expect(imported.err).toEqual([]);

		const out = path.join(dir, 'export.csv');
		const exported = captureIo();
		expect(await runCli(['export', '--vault', vault, '--folder', 'F', '--format', 'csv', '--out', out], exported.io)).toBe(0);
		expect(exported.err).toEqual([]);
		expect(exported.out.join('\n')).not.toContain('Not included:');

		const want = Papa.parse<Record<string, string>>(SOURCE, { header: true, skipEmptyLines: true });
		const back = Papa.parse<Record<string, string>>(fs.readFileSync(out, 'utf8'), { header: true, skipEmptyLines: true });
		// The header comes back in the source's own order, not the recipe's.
		expect(back.meta.fields?.slice(0, want.meta.fields?.length)).toEqual(want.meta.fields);
		expect(back.data).toHaveLength(want.data.length);
		const byId = new Map(back.data.map((r) => [r.id, r]));
		for (const row of want.data) {
			for (const column of want.meta.fields ?? []) {
				// List cells may come back with a space after the delimiter; the delimiter itself must match.
				expect({ id: row.id, column, value: (byId.get(row.id)?.[column] ?? '').replace(/; /g, ';') })
					.toEqual({ id: row.id, column, value: row[column] });
			}
		}
	}, 60000);
});
