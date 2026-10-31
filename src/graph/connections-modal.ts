import { Modal, Notice, TFile, type App } from 'obsidian';
import { VaultStillIndexingError } from '../generation/import-set';
import { ConnectionsError, loadConnectionsSnapshot, selectConnections, CONNECTIONS_MEMBERSHIP_TEXT, CONNECTIONS_NATIVE_LIMIT, type ConnectionsSnapshot, type ConnectionRow, type ConnectionEndpoint } from './connections-query';

export interface ConnectionsHost { openMappingReview(path: string): Promise<unknown> }
/** One ephemeral snapshot per refresh. Filters/pages never rescan canonical files. */
export class ConnectionsModal extends Modal {
	private lifetime = new AbortController();
	private request?: AbortController;
	private snapshot?: ConnectionsSnapshot;
	private source = '';
	private target = '';
	private focus = '';
	private search = '';
	private limit = 40;
	private offset = 0;
	private focusSelect!: HTMLSelectElement;
	private output!: HTMLDivElement;
	constructor(app: App, private host: ConnectionsHost) { super(app); }
	onOpen(): void {
		this.setTitle('Explore framework connections');
		this.modalEl.addClass('crosswalker-connections-modal');
		void this.load();
	}
	onClose(): void { this.lifetime.abort(); this.request?.abort(); this.contentEl.empty(); }
	private async load(): Promise<void> {
		this.request?.abort();
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: 'Reading imported sets and recorded assertions…' });
		try {
			const snapshot = await loadConnectionsSnapshot(this.app, this.lifetime.signal);
			if (this.lifetime.signal.aborted) return;
			this.snapshot = snapshot;
			this.controls();
		} catch (error) {
			if (this.lifetime.signal.aborted) return;
			this.contentEl.empty();
			this.contentEl.createEl('p', { text: error instanceof VaultStillIndexingError ? 'Obsidian is still indexing this vault. Wait for indexing to finish, then try again.' : error instanceof ConnectionsError ? error.message : 'Connections are unavailable. A vault record could not be read. Check that the vault is accessible, then try again.' });
			if (error instanceof ConnectionsError && error.details) {
				const details = this.contentEl.createEl('details'); details.createEl('summary', { text: 'Error details' });
				details.createEl('p', { text: error.details.cause });
				for (const path of error.details.paths) details.createEl('p', { text: path });
				details.createEl('p', { text: error.details.action });
			}
			this.button(this.contentEl, 'Try again', () => { void this.load(); });
		}
	}
	private controls(): void {
		const el = this.contentEl; el.empty(); el.addClass('crosswalker-connections');
		el.createEl('p', { cls: 'cw-connections-intro', text: 'Choose two imported sets to explore their recorded relationships. Your notes and graph settings stay unchanged.' });
		const selectors = el.createDiv({ cls: 'cw-connections-selectors' });
		this.setSelector(selectors, 'Source set', (id) => { this.source = id; this.selectionChanged(); });
		this.setSelector(selectors, 'Target set', (id) => { this.target = id; this.selectionChanged(); });
		const filters = el.createDiv({ cls: 'cw-connections-filters' });
		const focusLabel = filters.createEl('label', { text: 'Focal concept (optional)' });
		this.focusSelect = focusLabel.createEl('select', { attr: { 'aria-label': 'Focal concept' } });
		this.focusSelect.createEl('option', { value: '', text: 'All direct assertions' });
		this.focusSelect.addEventListener('change', () => { this.focus = this.focusSelect.value; this.offset = 0; void this.results(); });
		const searchLabel = filters.createEl('label', { text: 'Search recorded connections' });
		const search = searchLabel.createEl('input', { type: 'search', attr: { placeholder: 'Title, identifier, relationship or provider', 'aria-label': 'Search recorded connections' } });
		search.addEventListener('input', () => { this.search = search.value; this.offset = 0; void this.results(); });
		const sizeLabel = filters.createEl('label', { text: 'Rows per page' });
		const size = sizeLabel.createEl('input', { type: 'number', value: '40', attr: { min: '1', max: '100', 'aria-label': 'Rows per page' } });
		size.addEventListener('change', () => { this.limit = Number(size.value); this.offset = 0; void this.results(); });
		const toolbar = el.createDiv({ cls: 'cw-connections-toolbar' });
		const refresh = this.button(toolbar, 'Refresh records', () => { this.source = ''; this.target = ''; this.focus = ''; this.offset = 0; this.search = ''; void this.load(); });
		refresh.title = 'Read the vault again. Choose the source and target sets again afterward.';
		this.button(toolbar, 'Close connections', () => this.close()).addClass('cw-connections-close');
		this.output = el.createDiv({ cls: 'cw-connections-output', attr: { 'aria-live': 'polite' } });
		void this.results();
	}
	private setSelector(el: HTMLElement, label: string, choose: (id: string) => void): void {
		const field = el.createEl('label', { text: label });
		const search = field.createEl('input', { type: 'search', attr: { placeholder: 'Find an imported set', 'aria-label': `Find ${label.toLowerCase()}` } });
		const select = field.createEl('select', { attr: { 'aria-label': label } });
		const fill = (): void => {
			const selected = select.value;
			select.empty(); select.createEl('option', { value: '', text: 'Choose an imported set' });
			const q = search.value.toLocaleLowerCase();
			for (const option of this.snapshot!.choices) {
				if (option.id === selected || option.label.toLocaleLowerCase().includes(q)) select.createEl('option', { value: option.id, text: option.label });
			}
			select.value = selected;
		};
		fill(); search.addEventListener('input', fill);
		select.addEventListener('change', () => choose(select.value));
	}
	private selectionChanged(): void {
		this.focus = ''; this.offset = 0; this.focusSelect.empty();
		this.focusSelect.createEl('option', { value: '', text: 'All direct assertions' });
		const seen = new Set<string>();
		for (const row of this.snapshot!.tree.concepts) {
			const p = row.frontmatter._crosswalker as { import_set?: { id?: string } } | undefined;
			const set = p?.import_set?.id;
			if (!set || ![this.source, this.target].includes(set)) continue;
			const value = JSON.stringify([set, row.curie]);
			if (seen.has(value)) continue;
			seen.add(value);
			this.focusSelect.createEl('option', { value, text: `${row.title ?? row.curie} · ${row.curie} (${set})` });
		}
		void this.results();
	}
	private async results(): Promise<void> {
		this.request?.abort(); const request = new AbortController(); this.request = request;
		if (!this.source || !this.target) {
			this.output.empty(); this.output.createEl('p', { text: 'Choose both imported sets to explore their recorded connections. Nothing is selected automatically.' }); return;
		}
		this.output.empty(); this.output.createEl('p', { text: 'Finding readable assertions…' });
		try {
			const [focusSet, focusCurie] = this.focus ? JSON.parse(this.focus) as [string, string] : [undefined, undefined];
			const result = await selectConnections(this.snapshot!, { sourceSet: this.source, targetSet: this.target, focusSet, focusCurie, search: this.search, limit: this.limit, offset: this.offset }, request.signal);
			if (request.signal.aborted || this.lifetime.signal.aborted) return;
			this.output.empty();
			const { totals: t, filteredTotals: f, coverage: c } = result;
			this.output.createEl('p', { cls: 'cw-connections-totals', text: `Connections: ${f.positive} · Negative relationships: ${f.negative} · Needs resolution: ${f.unresolved}. Search: ${f.assertions} of ${t.assertions}.` });
			if (!c.complete || c.metadataWarnings.length) this.output.createEl('p', { cls: 'cw-connections-warning', text: 'Some vault records could not be checked. See coverage details below.' });
			const coverage = this.output.createEl('details', { cls: 'cw-connections-coverage' });
			coverage.createEl('summary', { text: 'Counts, coverage and limitations' });
			coverage.createEl('p', { text: `Before search: Connections: ${t.positive} · Negative relationships: ${t.negative} · Needs resolution: ${t.unresolved}. Total assertions: ${t.assertions}.` });
			coverage.createEl('p', { text: `${CONNECTIONS_MEMBERSHIP_TEXT} This does not establish which releases a publisher intended.` });
			coverage.createEl('p', { text: `Connections counts resolved nonnegative assertions. Needs resolution counts unresolved candidates separately. Negative total counts each resolved assertion once. For the current search, NOT: ${f.not}; no_relationship: ${f.noRelationship}. These two counts may overlap.` });
			coverage.createEl('p', { text: `Coverage ${c.complete ? 'complete for readable canonical assertions' : 'has exclusions'}: ${c.mappingExclusions.length} mapping exclusions, ${c.unclassifiedSkips.length} other files not evaluated, ${c.junctionNotesNotEvaluated} evidence notes not evaluated.` });
			coverage.createEl('p', { text: CONNECTIONS_NATIVE_LIMIT });
			coverage.createEl('p', { text: 'Evidence and junction notes are not evaluated by this query. Unclassified skips are not automatically missing mappings. Recorded provenance is not independently verified.' });
			for (const exclusion of [...c.mappingExclusions, ...c.unclassifiedSkips].slice(0, 100)) coverage.createEl('p', { text: `${exclusion.path}: ${exclusion.reason}` });
			if (c.mappingExclusions.length + c.unclassifiedSkips.length > 100) coverage.createEl('p', { text: 'Showing the first 100 coverage details. The command-line result includes the full diagnostic list.' });
			for (const warning of c.metadataWarnings) coverage.createEl('p', { text: warning });
			if (result.emptyMessage) this.output.createEl('p', { text: result.emptyMessage });
			const nav = this.output.createDiv({ cls: 'cw-connections-pagination' });
			const previous = this.button(nav, 'Previous page', () => { this.offset = Math.max(0, this.offset - this.limit); void this.results(); }); previous.disabled = this.offset === 0;
			nav.createSpan({ text: `Rows ${result.rows.length ? this.offset + 1 : 0}–${this.offset + result.rows.length} of ${f.assertions}` });
			const next = this.button(nav, 'Next page', () => { this.offset += this.limit; void this.results(); }); next.disabled = !result.hasMore;
			for (const row of result.rows) this.row(this.output, row);
		} catch (error) {
			if (request.signal.aborted || this.lifetime.signal.aborted) return;
			this.output.empty(); this.output.createEl('p', { text: error instanceof ConnectionsError ? error.message : 'These connections could not be read. Choose known sets, use a page size from 1 to 100, then refresh records if needed.' });
		}
	}
	private row(el: HTMLElement, row: ConnectionRow): void {
		const card = el.createDiv({ cls: 'cw-connection-row' });
		card.createDiv({ cls: 'cw-connection-state', text: row.category === 'unresolved' ? 'Endpoint needs attention' : row.negative ? 'Negative relationship' : 'Recorded connection' });
		const relation = card.createDiv({ cls: 'cw-connection-relation' });
		this.endpoint(relation, row.subject);
		relation.createDiv({ cls: 'cw-connection-predicate', text: `${row.modifier === 'NOT' ? 'NOT: ' : ''}${row.gloss.includes('not recorded') ? row.predicate : row.gloss}` });
		this.endpoint(relation, row.object);
		if (row.diagnostic) card.createEl('p', { text: row.diagnostic });
		if (row.provenance.release_conflict) card.createEl('p', { cls: 'cw-connections-warning', text: 'Release declarations conflict. See source details; unsupported release metadata was not applied.' });
		const action = this.button(card, row.locator.kind === 'table' ? 'Open mapping table' : 'Open assertion note', () => { void this.openAssertion(row); });
		action.title = row.locator.path;
		if (row.locator.rowId) card.createEl('p', { text: `Table row: ${row.locator.rowId}. The review opens the table, not a row anchor.` });
		const details = card.createEl('details'); details.createEl('summary', { text: 'Source details and recorded fields' });
		details.createEl('p', { text: `Assertion: ${row.identity}. Recorded relationship: ${row.modifier ? 'NOT ' : ''}${row.predicate}.` });
		details.createEl('p', { text: 'Owner release is a separate recorded declaration, not row-specific evidence unless the recorded release identity matches. Missing row identity or conflicting release identities/versions prevent inheritance.' });
		const facts = details.createEl('dl');
		for (const [key, value] of Object.entries(row.provenance)) { facts.createEl('dt', { text: key }); facts.createEl('dd', { text: this.value(value) }); }
		details.createEl('pre', { text: JSON.stringify(row.rawFields, null, 2) });
	}
	private endpoint(el: HTMLElement, endpoint: ConnectionEndpoint): void {
		const box = el.createDiv({ cls: 'cw-connection-endpoint' });
		box.createDiv({ text: endpoint.title }); box.createEl('code', { text: endpoint.curie });
		if (endpoint.recordedLabel) box.createDiv({ cls: 'setting-item-description', text: `Recorded mapping label: ${endpoint.recordedLabel}` });
		if (endpoint.path && endpoint.state === 'resolved') this.button(box, 'Open concept note', () => { void this.openNote(endpoint.path!); });
		else box.createDiv({ cls: 'setting-item-description', text: `${endpoint.state}. Inspect the source assertion or repair its endpoint records, then refresh. No note chosen.` });
	}
	private async openNote(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) { new Notice('This note is no longer available. Refresh records to resolve its current location.'); return; }
		try { await this.app.workspace.getLeaf('tab').openFile(file); }
		catch { new Notice('The note could not be opened. Check that it is readable, then refresh records.'); }
	}
	private async openAssertion(row: ConnectionRow): Promise<void> {
		if (row.locator.kind === 'note') return this.openNote(row.locator.path);
		const file = this.app.vault.getAbstractFileByPath(row.locator.path);
		if (!(file instanceof TFile)) { new Notice('This mapping table is no longer available. Refresh records to find its current location.'); return; }
		try { await this.host.openMappingReview(file.path); }
		catch { new Notice('The mapping table could not be opened. Check that the table is readable, then refresh records.'); }
	}
	private value(v: unknown): string { return v === null || v === undefined || v === '' ? 'Not recorded' : typeof v === 'string' ? v : JSON.stringify(v); }
	private button(el: HTMLElement, label: string, click: () => void): HTMLButtonElement {
		const b = el.createEl('button', { text: label }); b.addEventListener('click', click); return b;
	}
}
