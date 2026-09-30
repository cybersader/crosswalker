/**
 * A conversion job that throws instead of returning a result must still end in
 * a stopped result with actionable copy, free its running slot, let the
 * command move on to the next interrupted job, and redraw the stacks panel.
 */
import { TextDecoder } from 'node:util';
Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder, configurable: true });
import type { ConversionMarker } from '../src/mappings/conversion-marker';
import type { ConversionResult } from '../src/mappings/mapping-conversion';

jest.mock('../src/mappings/mapping-conversion', () => ({
	...jest.requireActual('../src/mappings/mapping-conversion'),
	resumeConversion: jest.fn(),
}));
jest.mock('../src/mappings/conversion-marker', () => ({
	...jest.requireActual('../src/mappings/conversion-marker'),
	readConversionReadState: jest.fn(),
}));

import { resumeConversion } from '../src/mappings/mapping-conversion';
import { readConversionReadState } from '../src/mappings/conversion-marker';
import { cancelFailureText, conversionConfirmLines, conversionNeedsConfirmation, finishInterruptedConversions, runConversionJob } from '../src/import/stack/mapping-conversion-ui';

function marker(setId: string): ConversionMarker {
	return { format: 'crosswalker-conversion-v1', import_set: setId, from: 'notes', to: 'table', phase: 'writing',
		target_path: `Invented/${setId}.mapping-table.tsv`, source_count: 3, started_at: '2026-09-30T00:00:00Z',
		plugin_version: '0.0.0', path: `Invented/${setId}.converting.json` } as ConversionMarker;
}

function plugin() {
	return { settings: { stacks: [], stackRuns: [] }, debug: { warn: jest.fn() }, refreshInstalledStacksPanels: jest.fn(),
		runProjection: jest.fn(), precomputeClosure: jest.fn() };
}

it('turns a throwing resume into a stopped result and continues to the next marker', async () => {
	const ok: ConversionResult = { ok: true, setId: 'iset-err002', from: 'notes', to: 'table', rows: 3, reviewsCarried: 0,
		targetPath: 'Invented/iset-err002.mapping-table.tsv', trashed: 3, phaseReached: 'done', warnings: [] };
	(readConversionReadState as jest.Mock).mockResolvedValue({ markers: [marker('iset-err001'), marker('iset-err002')], unusable: [] });
	(resumeConversion as jest.Mock)
		.mockRejectedValueOnce(new Error('EACCES: invented raw failure'))
		.mockResolvedValueOnce(ok);
	const host = plugin();
	const results = await finishInterruptedConversions({} as never, host as never);
	expect(results).toHaveLength(2);
	expect(results[0].ok).toBe(false);
	expect(results[0].setId).toBe('iset-err001');
	expect(results[0].reason).toContain('import set iset-err001');
	expect(results[0].reason).toContain('finish the conversion');
	expect(results[0].reason).not.toContain('EACCES');
	expect(results[0].reason).not.toContain('—');
	expect(results[1]).toEqual(ok);
	expect(host.debug.warn).toHaveBeenCalledTimes(1);
	expect(host.refreshInstalledStacksPanels).toHaveBeenCalledTimes(1);
	// The running slot was freed: a second pass runs the same job again.
	(resumeConversion as jest.Mock).mockResolvedValueOnce(ok).mockResolvedValueOnce(ok);
	expect((await finishInterruptedConversions({} as never, host as never)).every((result) => result.ok)).toBe(true);
});

it('passes a returned result through untouched', async () => {
	const stopped = { ok: false, reason: 'Invented reason.' } as ConversionResult;
	expect(await runConversionJob(plugin() as never, async () => stopped, { setId: 'x', from: 'notes', to: 'table', label: 'x' })).toBe(stopped);
});

it('names a cause and an action when cancel fails, and never the raw error', () => {
	const text = cancelFailureText('import set iset-err001', 'table');
	expect(text).toContain('open in another program');
	expect(text).toContain('cancel again');
	expect(text).not.toContain('—');
});

it('does not call a split set the vault root, and skips asking about it', () => {
	const split = { rowCount: 4, root: null };
	expect(conversionConfirmLines({ ...split, noteCount: 0 }, 'notes')[0])
		.toBe("Writes 4 notes. Crosswalker could not tell which folder they belong in, so the conversion will refuse until the set's files share one folder.");
	expect(conversionNeedsConfirmation(split, 'table', 1000)).toBe(false);
	expect(conversionNeedsConfirmation(split, 'notes', 0)).toBe(false);
});
