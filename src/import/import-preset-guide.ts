import { isGenericRecipe, RECIPE_REGISTRY, type RecipeRegistryEntry } from './recipe-registry';

/** Return built-in presets in the registry's deterministic display order. */
export function presetGuideEntries(): ReadonlyArray<RecipeRegistryEntry> {
	return RECIPE_REGISTRY.filter(isGenericRecipe);
}

function externalLink(className: string, label: string, url: string): HTMLAnchorElement {
	const link = document.createElement('a');
	link.className = className;
	link.textContent = label;
	link.href = url;
	link.target = '_blank';
	link.rel = 'noopener';
	return link;
}

/** Render the shared, state-free guide to publisher files and import instructions. */
export function renderPresetGuide(parent: HTMLElement): HTMLDetailsElement {
	const entries = presetGuideEntries();
	const details = document.createElement('details');
	details.className = 'crosswalker-preset-guide';
	details.dataset.presetCount = String(entries.length);

	const summary = document.createElement('summary');
	summary.className = 'crosswalker-preset-guide-summary';
	summary.textContent = `Browse built-in import presets (${entries.length})`;
	details.append(summary);

	const intro = document.createElement('p');
	intro.className = 'crosswalker-preset-guide-intro';
	intro.textContent = 'Crosswalker recognizes these publisher files automatically. Download the file from the publisher, then choose it below. Some publishers ask you to register before downloading.';
	details.append(intro);

	const list = document.createElement('ul');
	list.className = 'crosswalker-preset-guide-list';
	for (const entry of entries) {
		const item = document.createElement('li');
		item.className = 'crosswalker-preset-guide-item';
		item.dataset.recipeId = entry.id;

		const label = document.createElement('strong');
		label.className = 'crosswalker-preset-guide-label';
		label.textContent = entry.label;
		item.append(label);

		const description = document.createElement('span');
		description.className = 'crosswalker-preset-guide-desc';
		description.textContent = entry.description;
		item.append(description);

		const links = document.createElement('div');
		links.className = 'crosswalker-preset-guide-links';
		if (entry.sourceLink) {
			links.append(externalLink(
				'crosswalker-preset-guide-source',
				entry.sourceLink.label,
				entry.sourceLink.url,
			));
		}
		links.append(externalLink(
			'crosswalker-preset-guide-docs',
			'How to import it',
			entry.docsUrl,
		));
		item.append(links);

		const noteText = entry.sourceLink?.note
			?? (entry.id === 'evidence-junction-notes' ? 'Built from your own evidence spreadsheet.' : undefined);
		if (noteText) {
			const note = document.createElement('small');
			note.className = 'crosswalker-preset-guide-note';
			note.textContent = noteText;
			item.append(note);
		}

		list.append(item);
	}
	details.append(list);
	parent.append(details);
	return details;
}
