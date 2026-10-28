/**
 * The evidence recipe imported with no destination lands its junction notes
 * directly in `Evidence/Junctions`. Its file template used to repeat that
 * folder, so the default destination and the template were joined and every
 * note landed in `Evidence/Junctions/Evidence/Junctions/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCli } from '../../cli/crosswalker';
import { REPO, captureIo, installByteFile, tempDir } from './helpers';

installByteFile();

describe('cw import with the evidence recipe and no destination', () => {
	it('writes junction notes once under Evidence/Junctions', async () => {
		const vault = tempDir('evidence-destination');
		const { io, err } = captureIo();
		const code = await runCli([
			'import', '--vault', vault,
			'--source', path.join(REPO, 'tools/fixtures/demo/evidence-links.csv'),
			'--recipe', 'evidence-junction-notes', '--deterministic',
		], io);
		expect({ code, errors: err.filter((line) => !line.startsWith('warning: ')) }).toEqual({ code: 0, errors: [] });

		const folder = path.join(vault, 'Evidence/Junctions');
		const notes = fs.readdirSync(folder).filter((name) => name.endsWith('.md')).sort();
		expect(notes).toContain('jn-ac-1-access-control-policy.md');
		expect(notes).toHaveLength(5);
		expect(fs.existsSync(path.join(folder, 'Evidence'))).toBe(false);
	});
});
