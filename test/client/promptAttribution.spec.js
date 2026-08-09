import { getPromptSourceAttribution } from '../../client/Components/GameBoard/promptAttribution';

describe('getPromptSourceAttribution', function () {
    const source = { id: '1', name: 'Krump', image: 'krump.png', type: 'creature' };

    it('returns null when there are no controls', function () {
        expect(getPromptSourceAttribution(undefined)).toBeNull();
        expect(getPromptSourceAttribution([])).toBeNull();
    });

    it('returns null when no control carries a source', function () {
        expect(getPromptSourceAttribution([{ type: 'house-select' }])).toBeNull();
    });

    it('returns null for a targeting control, which already renders its own source', function () {
        // AbilityTargeting draws source -> targets itself; repeating it here
        // would duplicate the same thumbnail.
        expect(getPromptSourceAttribution([{ type: 'targeting', source, targets: [] }])).toBeNull();
    });

    it('returns the source for a house-select control', function () {
        expect(getPromptSourceAttribution([{ type: 'house-select', source }])).toBe(source);
    });

    it('returns the source for an options-select control', function () {
        expect(getPromptSourceAttribution([{ type: 'options-select', source }])).toBe(source);
    });

    it('returns the source for a card-name control', function () {
        expect(getPromptSourceAttribution([{ type: 'card-name', source }])).toBe(source);
    });

    it('returns the source for a trait-name control', function () {
        expect(getPromptSourceAttribution([{ type: 'trait-name', source }])).toBe(source);
    });

    it('finds a source on a later control when the first has none', function () {
        expect(
            getPromptSourceAttribution([{ type: 'house-select' }, { type: 'house-select', source }])
        ).toBe(source);
    });
});
