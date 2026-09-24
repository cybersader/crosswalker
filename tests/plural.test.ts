import { plural } from '../src/utils/plural';

describe('plural', () => {
	it('uses singular only for one', () => {
		expect(plural(1, 'note')).toBe('1 note');
		expect(plural(0, 'note')).toBe('0 notes');
		expect(plural(2, 'note')).toBe('2 notes');
	});
	it('formats large counts for reading', () => {
		expect(plural(1234, 'note')).toBe(`${(1234).toLocaleString()} notes`);
	});
	it('accepts an irregular plural', () => {
		expect(plural(1, 'category', 'categories')).toBe('1 category');
		expect(plural(3, 'category', 'categories')).toBe('3 categories');
	});
});
