const {
    createContentFilter,
    filterText,
    normalise
} = require('../../server/services/moderation/contentFilter');

/**
 * ARCHON: filtering objectionable material out of chat.
 *
 * App Store Review Guideline 1.2 asks a UGC app for four things; this app had
 * reporting, blocking and published contact, and nothing at all for the first -
 * "a method for filtering objectionable material from being posted". Every chat
 * surface applied one transformation, a 512-character truncate.
 *
 * The hard part of a filter like this is not catching slurs. It is NOT catching
 * everything else: this is a KeyForge site, where people type card names, house
 * names and deck names constantly, and a filter that eats those is a filter
 * players route around by not using chat. So roughly half of what follows
 * asserts that ordinary play chat passes through untouched.
 */
describe('content filter', function () {
    describe('normalising', function () {
        it('folds homoglyphs to letters', function () {
            expect(normalise('f4gg0t')).toBe(normalise('faggot'));
            expect(normalise('sh1t')).toBe(normalise('shit'));
        });

        it('collapses a stretched letter', function () {
            // "retaaaard" and "retard" are the same word to everyone but a
            // naive string compare.
            expect(normalise('retaaaard')).toBe(normalise('retard'));
        });

        it('drops separators used to break a word up', function () {
            expect(normalise('f-a-g-g-o-t')).toBe(normalise('faggot'));
            expect(normalise('f.a.g.g.o.t')).toBe(normalise('faggot'));
        });
    });

    describe('masking', function () {
        it('masks a slur', function () {
            const { text, filtered } = createContentFilter().clean('you are a faggot');

            expect(filtered).toBe(true);
            expect(text).not.toContain('faggot');
            expect(text).toContain('you are a');
        });

        it('masks it through homoglyph and stretch evasion', function () {
            expect(filterText('f4gg0t')).not.toContain('f4gg0t');
            expect(filterText('retaaaard')).not.toContain('reta');
        });

        it('masks letters spaced out to slip past a word filter', function () {
            // The first thing anybody tries once whole words are caught.
            expect(filterText('n i g g e r')).toBe('******');
        });

        it('masks a term wearing punctuation', function () {
            expect(filterText('(faggot)')).not.toContain('faggot');
            expect(filterText('faggot!')).not.toContain('faggot');
        });

        it('sends the message rather than dropping it', function () {
            // Silently swallowing a message teaches somebody to send it again;
            // refusing it with an error turns the filter into a game.
            const { text } = createContentFilter().clean('nice retard play');

            expect(text).toContain('nice');
            expect(text).toContain('play');
        });

        it('reports whether it changed anything', function () {
            expect(createContentFilter().clean('good game').filtered).toBe(false);
            expect(createContentFilter().clean('cunt').filtered).toBe(true);
        });
    });

    /**
     * The half that matters more day to day. A false positive here is a player
     * who cannot name the card in their hand.
     */
    describe('leaving ordinary play chat alone', function () {
        const innocent = [
            'good game, well played',
            'I have 3 amber and two keys',
            'Shadows is my favourite house',
            'play Bait and Switch then Too Much to Protect',
            'my deck is Nizzle the Sniffer',
            'scrap that creature',
            'assassinate the artifact',
            'Grim Reminders is the best set',
            'that was a classic Dis play',
            'reap with everything',
            'a b c',
            'g g'
        ];

        for (const message of innocent) {
            it(`passes "${message}" through unchanged`, function () {
                const { text, filtered } = createContentFilter().clean(message);

                expect(filtered, `"${message}" was masked`).toBe(false);
                expect(text).toBe(message);
            });
        }

        it('does not match inside a longer word', function () {
            // Substring matching is what makes filters infamous. "Scunthorpe"
            // is the canonical example and it must survive.
            expect(createContentFilter().clean('Scunthorpe').filtered).toBe(false);
            expect(createContentFilter().clean('grape').filtered).toBe(false);
            expect(createContentFilter().clean('therapist').filtered).toBe(false);
        });

        it('does not fold neighbouring short words into a new one', function () {
            // The spaced-letter rule only joins runs of SINGLE characters, so
            // ordinary short words are never glued together.
            expect(createContentFilter().clean('is it a go or no').filtered).toBe(false);
        });
    });

    describe('preserving the message', function () {
        it('keeps spacing intact', function () {
            const { text } = createContentFilter().clean('well played, good game');

            expect(text).toBe('well played, good game');
        });

        it('handles an empty or missing message without throwing', function () {
            expect(createContentFilter().clean('')).toEqual({ text: '', filtered: false });
            expect(createContentFilter().clean(undefined).filtered).toBe(false);
            expect(createContentFilter().clean(null).filtered).toBe(false);
        });
    });

    describe('extending the list', function () {
        it('accepts operator-supplied terms', function () {
            // So a site can respond to whatever its own community throws up
            // without waiting for a release.
            const filter = createContentFilter({ extra: ['badword'] });

            expect(filter.clean('badword').filtered).toBe(true);
            expect(createContentFilter().clean('badword').filtered).toBe(false);
        });

        it('normalises the extra terms too, so evasion does not bypass them', function () {
            const filter = createContentFilter({ extra: ['BadWord'] });

            expect(filter.clean('b4dw0rd').filtered).toBe(true);
        });
    });
});
