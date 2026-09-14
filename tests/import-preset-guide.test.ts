import { renderPresetGuide, presetGuideEntries } from '../src/import/import-preset-guide';
import { RECIPE_REGISTRY } from '../src/import/recipe-registry';

function entry(id: string) {
	const found = presetGuideEntries().find((candidate) => candidate.id === id);
	if (!found) throw new Error(`Missing preset guide entry: ${id}`);
	return found;
}

describe('import preset guide', () => {
	it('exposes complete, unique, secure guidance metadata in registry order', () => {
		const entries = presetGuideEntries();
		expect(entries.length).toBe(RECIPE_REGISTRY.length);
		expect(new Set(entries.map((candidate) => candidate.id)).size).toBe(entries.length);

		for (const candidate of entries) {
			expect(candidate.docsUrl).toMatch(
				/^https:\/\/cybersader\.github\.io\/crosswalker\/reference\/framework-data-sources\//,
			);
			if (candidate.sourceLink) expect(candidate.sourceLink.url).toMatch(/^https:\/\//);
		}
	});

	it('records registration requirements and leaves the evidence preset publisher-free', () => {
		for (const id of ['cis-controls-v8-controls', 'cis-controls-v8-flat', 'cri-profile-v2-2-flat']) {
			expect(entry(id).sourceLink?.note).toMatch(/registration/i);
		}
		expect(entry('evidence-junction-notes').sourceLink).toBeUndefined();
	});

	it('renders the closed native disclosure with one secure link set per preset', () => {
		const parent = document.createElement('div');
		const details = renderPresetGuide(parent);
		const entries = presetGuideEntries();
		const items = details.querySelectorAll<HTMLLIElement>(
			'li.crosswalker-preset-guide-item[data-recipe-id]',
		);

		expect(details.open).toBe(false);
		expect(details.dataset.presetCount).toBe(String(entries.length));
		expect(items).toHaveLength(entries.length);
		expect(Array.from(items, (item) => item.dataset.recipeId)).toEqual(
			entries.map((candidate) => candidate.id),
		);
		for (const anchor of details.querySelectorAll('a')) {
			expect(anchor.rel).toBe('noopener');
			expect(anchor.target).toBe('_blank');
		}
		expect(details.textContent).not.toContain('—');
	});
});
