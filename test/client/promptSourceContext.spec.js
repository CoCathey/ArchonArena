import { getPromptSourceContext } from '../../client/Components/GameBoard/promptSourceContext.js';

const card = (name) => ({ name, uuid: `${name}-uuid` });

describe('getPromptSourceContext', function () {
    it('returns the source and targets for a non-targeting control', function () {
        const context = getPromptSourceContext([
            { type: 'card-name', source: card('Krump'), targets: [card('Bumpsy')] }
        ]);

        expect(context).toEqual({ source: card('Krump'), targets: [card('Bumpsy')] });
    });

    it('defaults targets to an empty array when the control carries none', function () {
        const context = getPromptSourceContext([{ type: 'trait-name', source: card('Krump') }]);

        expect(context.targets).toEqual([]);
    });

    // AbilityTargeting already renders the source card for a targeting
    // control - showing it again here would just duplicate the same card.
    it('stays quiet for a targeting control, which already shows its source', function () {
        expect(
            getPromptSourceContext([{ type: 'targeting', source: card('Krump'), targets: [] }])
        ).toBeNull();
    });

    it('returns null when the first control has no source', function () {
        expect(getPromptSourceContext([{ type: 'house-select' }])).toBeNull();
    });

    it('only looks at the first control, matching the text-interpolation source', function () {
        expect(
            getPromptSourceContext([
                { type: 'house-select' },
                { type: 'card-name', source: card('Krump') }
            ])
        ).toBeNull();
    });

    it('handles missing or empty controls', function () {
        expect(getPromptSourceContext(undefined)).toBeNull();
        expect(getPromptSourceContext(null)).toBeNull();
        expect(getPromptSourceContext([])).toBeNull();
    });
});
