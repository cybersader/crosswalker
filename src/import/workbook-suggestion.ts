import type { TablePeek } from './parsers/table-peek';
import type { RecipeRegistryEntry } from './recipe-registry';
import { scoreFilePeeks } from './vault-source-scan';

export interface WorkbookSuggestion {
	sheetName: string;
	headerRow: number;
	recipeId: string;
	label: string;
	score: number;
	confident: boolean;
}

/** Map the shared source scanner's best workbook candidate to wizard input state. */
export function suggestWorkbookBinding(
	peeks: TablePeek[],
	fileName: string,
	registry: RecipeRegistryEntry[],
): WorkbookSuggestion | null {
	const candidate = scoreFilePeeks(fileName, fileName, peeks, registry);
	if (!candidate || candidate.table === '') return null;
	return {
		sheetName: candidate.table,
		headerRow: candidate.headerRow,
		recipeId: candidate.entryId,
		label: candidate.label,
		score: candidate.score,
		confident: candidate.confident,
	};
}
