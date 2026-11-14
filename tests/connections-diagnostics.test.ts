import type { App } from 'obsidian';
import * as importSets from '../src/generation/import-set';
import * as vaultReader from '../src/export/vault-reader';
import { ConnectionsError, loadConnectionsSnapshot } from '../src/graph/connections-query';
import { ConnectionsModal } from '../src/graph/connections-modal';
import { DebugLog } from '../src/utils/debug';

// Synthetic exceptions only. Never use real vault contents or host identifiers.
const privateText = 'Synthetic private note body and exception detail';
const token = `ghp_${'a'.repeat(36)}`;
function setup() {
	const writes = { append: jest.fn(), write: jest.fn(), modify: jest.fn(), create: jest.fn(), delete: jest.fn() };
	const app = { vault: { adapter: writes, ...writes, read: jest.fn(() => privateText), getAbstractFileByPath: jest.fn() } } as unknown as App;
	const debug = new DebugLog(app, false, false, { view: false }, 'error');
	jest.spyOn(importSets, 'requireVaultIndexed').mockResolvedValue(undefined);
	jest.spyOn(importSets, 'discoverImportSets').mockResolvedValue([]);
	jest.spyOn(vaultReader, 'readVaultTree').mockResolvedValue({ concepts: [], crosswalkEdges: [], junctionNotes: [], hubs: [], skipped: [] });
	const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
	return { app, debug, writes, consoleError };
}
async function failure(app: App, debug: Pick<DebugLog, 'error'>): Promise<ConnectionsError> {
	try { await loadConnectionsSnapshot(app, undefined, debug); }
	catch (error) { expect(error).toBeInstanceOf(ConnectionsError); return error as ConnectionsError; }
	throw new Error('Expected the snapshot to fail closed.');
}
afterEach(() => jest.restoreAllMocks());

describe('Connections failure diagnostics', () => {
	it('captures one known provenance failure with logging off, never skipping the failed set or writing', async () => {
		const { app, debug, writes, consoleError } = setup();
		const original = new importSets.ImportSetProvenanceError(`both notes and a table ${privateText} ${token}`, ['Mappings/record.md']);
		jest.mocked(importSets.discoverImportSets).mockRejectedValueOnce(original);
		const error = await failure(app, debug);
		expect(error.details).toMatchObject({ cause: 'The same imported set is recorded in conflicting storage forms.', paths: ['Mappings/record.md'], action: expect.stringContaining('conversion') });
		expect(error.cause).toBe(original);
		expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
		expect(JSON.stringify(error)).not.toContain(privateText);
		expect(vaultReader.readVaultTree).not.toHaveBeenCalled();
		expect(debug.getRingBuffer()).toHaveLength(1);
		expect(debug.getRingBuffer()[0]).toMatchObject({ level: 'error', category: 'view', op: 'connections-read-failed', operation: 'discover-import-sets', error_kind: 'import-set-provenance', affected_paths: ['Mappings/record.md'] });
		expect(consoleError).toHaveBeenCalledTimes(1);
		expect(app.vault.read).not.toHaveBeenCalled();
		for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
		const emitted = JSON.stringify([debug.getRingBuffer(), consoleError.mock.calls]);
		for (const secret of [privateText, token, original.stack!]) expect(emitted).not.toContain(secret);
		// Local debugging keeps filenames useful; sharing still uses the existing redaction boundary.
		expect(emitted).toContain('Mappings/record.md');
		const shared = debug.assembleDiagnostics({ pluginVersion: 'test', obsidianVersion: 'test', platform: 'test', settings: {} });
		expect(shared).not.toContain('record.md');
		expect(JSON.parse(shared).recent_events[0].affected_paths).toEqual(['[redacted]']);
	});

	it.each([
		[new TypeError(`${privateText} ${token}`), 'type-error'],
		[new Error(`${privateText} ${token}`), 'error'],
		[{ name: token, message: privateText, stack: privateText, paths: ['/private/host/note.md'] }, 'non-error'],
	])('captures unknown tree failures without inspecting arbitrary error properties (%s)', async (original, kind) => {
		const { app, debug, consoleError } = setup();
		jest.mocked(vaultReader.readVaultTree).mockRejectedValueOnce(original);
		const error = await failure(app, debug);
		expect(error.cause).toBe(original);
		expect(error.details).toMatchObject({ cause: 'A vault record could not be read.', paths: [] });
		expect(debug.getRingBuffer()).toHaveLength(1);
		expect(debug.getRingBuffer()[0]).toMatchObject({ operation: 'read-vault-tree', error_kind: kind, affected_paths: [] });
		expect(consoleError).toHaveBeenCalledTimes(1);
		const emitted = JSON.stringify([debug.getRingBuffer(), consoleError.mock.calls]);
		for (const secret of [privateText, token, '/private/host', 'stack', 'message']) expect(emitted).not.toContain(secret);
	});

	it('rejects unsafe known paths before normalization and bounds and redacts diagnostic context', async () => {
		const { app, debug } = setup();
		jest.mocked(importSets.discoverImportSets).mockRejectedValueOnce(new importSets.ImportSetProvenanceError('Invalid frontmatter', [
			'/private/host/note.md', '\\private\\host\\note.md', 'C:\\private\\note.md', '../escape.md', 'safe/../escape.md',
			'https://example.invalid/secret', 'line\ncontent.md', '', '.',
			'Valid\\nested\\record.md', `Mappings/${token}/record.md`, `Mappings/backup_${token}.md`,
			...Array.from({ length: 30 }, (_, n) => `Set${n}/record.md`),
		]));
		const error = await failure(app, debug);
		expect(error.details?.paths).toContain('Valid/nested/record.md');
		expect(error.details?.paths).not.toEqual(expect.arrayContaining(['../escape.md', '/private/host/note.md', '.']));
		const event = debug.getRingBuffer()[0];
		expect(event.affected_paths).toHaveLength(20);
		expect(event.affected_path_count).toBe(33);
		expect(JSON.stringify(event)).not.toContain(token);
		expect(JSON.stringify(event)).not.toContain('private');
		expect(event.affected_paths).toEqual(expect.arrayContaining(['Valid/nested/record.md', 'Mappings/[REDACTED].md', 'Mappings/backup_[REDACTED].md']));
	});

	it('distinguishes unexpected readiness failure from imported-set errors and retains its cause', async () => {
		const { app, debug } = setup(), original = new Error(privateText);
		jest.mocked(importSets.requireVaultIndexed).mockRejectedValueOnce(original);
		const error = await failure(app, debug);
		expect(error.message).toContain('Vault readiness could not be checked');
		expect(error.cause).toBe(original);
		expect(debug.getRingBuffer()).toHaveLength(1);
		expect(debug.getRingBuffer()[0]).toMatchObject({ operation: 'check-vault-readiness', error_kind: 'error', affected_paths: [] });
		expect(importSets.discoverImportSets).not.toHaveBeenCalled();
	});

	it('does not record expected indexing or cancellation as read failures', async () => {
		const { app, debug } = setup(), original = new importSets.VaultStillIndexingError();
		jest.mocked(importSets.requireVaultIndexed).mockRejectedValueOnce(original);
		await expect(loadConnectionsSnapshot(app, undefined, debug)).rejects.toBe(original);
		const cancel = new AbortController(); cancel.abort();
		await expect(loadConnectionsSnapshot(app, cancel.signal, debug)).rejects.toThrow('cancelled');
		const during = new AbortController();
		jest.mocked(importSets.discoverImportSets).mockImplementationOnce(async () => { during.abort(); return []; });
		await expect(loadConnectionsSnapshot(app, during.signal, debug)).rejects.toThrow('cancelled');
		expect(debug.getRingBuffer()).toEqual([]);
	});

	it('does not let a throwing logger or console replace the original actionable error', async () => {
		const { app, debug, consoleError } = setup(), original = new Error(privateText);
		jest.mocked(importSets.discoverImportSets).mockRejectedValue(original);
		const logger = { error: jest.fn(() => { throw new Error('Synthetic logger failed'); }) };
		const error = await failure(app, logger);
		expect(error.cause).toBe(original);
		expect(error.message).toContain('An imported set could not be read');
		expect(logger.error).toHaveBeenCalledTimes(1);
		consoleError.mockImplementation(() => { throw new Error('Synthetic console failed'); });
		expect((await failure(app, debug)).cause).toBe(original);
		expect(debug.getRingBuffer()).toHaveLength(1);
	});

	it('wires the modal to the existing logger without emitting a duplicate event when it catches', async () => {
		const { app, debug, consoleError } = setup();
		jest.mocked(importSets.discoverImportSets).mockRejectedValueOnce(new Error(privateText));
		const modal = new ConnectionsModal(app, { debug, openMappingReview: jest.fn() });
		const node = { createEl: jest.fn(), addEventListener: jest.fn() };
		node.createEl.mockReturnValue(node);
		(modal.contentEl.createEl as jest.Mock).mockReturnValue(node);
		await (modal as unknown as { load(): Promise<void> }).load();
		expect(debug.getRingBuffer()).toHaveLength(1);
		expect(consoleError).toHaveBeenCalledTimes(1);
		expect(modal.contentEl.createEl).toHaveBeenCalledWith('p', { text: expect.stringContaining('An imported set could not be read') });
	});
});
