import { describe, expect, it } from 'vitest';
import { cardAccessibilityLabel } from '../src/game/cardLabel';

// A card tile is an image with no text of its own, so VoiceOver has nothing
// to read unless the tile says what it is. These pin the label down: the
// name first, then only the state a player would want announced.
describe('cardAccessibilityLabel', () => {
    it('reads the card name', () => {
        expect(cardAccessibilityLabel({ uuid: 'a', name: 'Rad Penny' })).toBe('Rad Penny');
    });

    it('does not reveal a face-down card', () => {
        expect(cardAccessibilityLabel({ uuid: 'a', name: 'Rad Penny', facedown: true })).toBe(
            'Face-down card'
        );
    });

    it('falls back when the summary carries no name', () => {
        expect(cardAccessibilityLabel({ uuid: 'a' })).toBe('Card');
    });

    it('announces exhaustion, stun, ward and damage after the name', () => {
        expect(
            cardAccessibilityLabel({
                uuid: 'a',
                name: 'Bonesaw',
                exhausted: true,
                stunned: true,
                tokens: { ward: 1, damage: 2 }
            })
        ).toBe('Bonesaw, exhausted, stunned, warded, 2 damage');
    });

    it('treats a stun token like the stunned flag and ignores empty tokens', () => {
        expect(
            cardAccessibilityLabel({ uuid: 'a', name: 'Envy', tokens: { stun: 1, damage: 0 } })
        ).toBe('Envy, stunned');
    });
});
