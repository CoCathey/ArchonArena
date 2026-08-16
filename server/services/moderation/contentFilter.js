/**
 * ARCHON: filtering objectionable material out of user-generated text.
 *
 * App Store Review Guideline 1.2 asks a UGC app for four things. Archon Arena
 * had three of them - reporting, blocking, published contact - and none of the
 * first: "a method for filtering objectionable material from being posted".
 * Every chat path applied exactly one transformation, a 512-character truncate,
 * and moderation was entirely after the fact: somebody had to see it, report
 * it, and wait for a human. That is the right *second* line and a poor first
 * one, because the harm has already landed by the time it runs.
 *
 * ## What this is, and what it deliberately is not
 *
 * It masks a small list of slurs and severe profanity. It is not a toxicity
 * classifier and does not try to be: the list is short, the matching is strict,
 * and anything subtler is left to the humans in the moderation queue, who can
 * see context this cannot.
 *
 * That choice matters. An aggressive filter on a card-game site is actively
 * harmful - KeyForge has houses, cards and decks whose real names collide with
 * innocent substrings, and a player unable to say the name of the card in their
 * hand will conclude the site is broken. So matching is on WHOLE WORDS after
 * normalisation, never on substrings, and the default list holds only terms
 * with no innocent reading.
 *
 * ## Why normalise first
 *
 * A denylist compared against raw text catches nothing; the first person to
 * type `f u c k` or `sh1t` is past it. So each word is folded before it is
 * checked - homoglyph digits and symbols to letters, runs of a repeated letter
 * collapsed, separators dropped. The text a player sees is never the folded
 * version; folding decides only whether to mask.
 *
 * ## Masked, not blocked
 *
 * The message still sends, with the term replaced by asterisks. Silently
 * dropping a message teaches somebody to type it again, and refusing it with an
 * error turns the filter into a game to beat. Masking is quiet and final, and
 * the person on the other end is not shown the word either way, which is the
 * whole point.
 */

/**
 * Terms with no innocent reading in a card-game chat. Deliberately short - see
 * the header on why a long list costs more than it earns here. The operator can
 * extend it through the `extra` option without a release.
 *
 * Written folded (as `normalise` would produce them) so the comparison is
 * symmetrical.
 */
const DEFAULT_TERMS = [
    'nigger',
    'nigga',
    'faggot',
    'fag',
    'tranny',
    'retard',
    'retarded',
    'kike',
    'spic',
    'chink',
    'wetback',
    'cunt',
    'rape',
    'rapist',
    'paedophile',
    'pedophile',
    'nonce'
];

/** Homoglyphs a determined typist reaches for first. */
const HOMOGLYPHS = {
    0: 'o',
    1: 'i',
    '!': 'i',
    '|': 'i',
    3: 'e',
    4: 'a',
    '@': 'a',
    5: 's',
    $: 's',
    7: 't',
    '+': 't',
    8: 'b'
};

/**
 * Fold a word to the form the denylist is written in.
 *
 * Order matters: homoglyphs become letters, then anything that is not a letter
 * is dropped (so `f-u-c-k` and `f.u.c.k` collapse), then a run of the same
 * letter shrinks to one (so `niiiigger` and `fuuuck` fold together). The last
 * step is why the list is written with single letters throughout.
 *
 * @param {string} word
 * @returns {string}
 */
function normalise(word) {
    return String(word || '')
        .toLowerCase()
        .replace(/[0-9!|@$+]/g, (character) => HOMOGLYPHS[character] || character)
        .replace(/[^a-z]/g, '')
        .replace(/(.)\1+/g, '$1');
}

/**
 * Every folded form a word could reasonably be denied under.
 *
 * Two are needed, because the homoglyph table cuts both ways. Mapping `!` to
 * `i` is what catches `sh!t` - and it is also what let `faggot!` through, since
 * the trailing mark folded INTO the word and produced `faggoti`, which is not
 * on the list. Punctuation at the edge of a word is ordinary writing;
 * punctuation standing in for a letter is evasion, and the same character does
 * both jobs.
 *
 * So a word is checked twice: once with homoglyphs substituted, and once with
 * every non-letter simply dropped. A term is denied if either form matches.
 * Trying both is cheaper than trying to tell the two intentions apart.
 *
 * @param {string} word
 * @returns {string[]}
 */
function foldings(word) {
    const stripped = String(word || '')
        .toLowerCase()
        .replace(/[^a-z]/g, '')
        .replace(/(.)\1+/g, '$1');

    return [normalise(word), stripped];
}

/**
 * Build a filter.
 *
 * @param {object} [options]
 * @param {string[]} [options.extra] additional terms, from configuration
 * @returns {{clean: function(string): {text: string, filtered: boolean}}}
 */
function createContentFilter({ extra = [] } = {}) {
    const terms = new Set(
        [...DEFAULT_TERMS, ...extra].map((term) => normalise(term)).filter(Boolean)
    );

    /**
     * Mask any denied term in `text`.
     *
     * Splits on whitespace and keeps the original separators, so the message
     * comes back with its spacing intact - a filter that reflows somebody's
     * text is a filter they will notice for the wrong reason.
     *
     * @param {string} text
     * @returns {{text: string, filtered: boolean}}
     */
    const clean = (text) => {
        if (!text || typeof text !== 'string') {
            return { text: text, filtered: false };
        }

        let filtered = false;

        // ARCHON: spaced-out letters, the first evasion anybody reaches for
        // once whole words are masked. Handled before the word pass because it
        // spans words by definition.
        //
        // Deliberately narrow: only runs of THREE OR MORE single-character
        // tokens are joined and tested. That shape does not occur in ordinary
        // play chat, whereas joining everything would fold innocent
        // neighbouring words into new ones and mask them.
        let working = text.replace(/(?:(?:^|\s)\S){3,}(?=$|\s)/g, (run) => {
            const letters = run.trim().split(/\s+/);

            if (letters.some((letter) => letter.length !== 1)) {
                return run;
            }

            if (!foldings(letters.join('')).some((form) => terms.has(form))) {
                return run;
            }

            filtered = true;

            // The leading separator is part of the match; keep it so the
            // sentence does not lose a space.
            return (/^\s/.test(run) ? run[0] : '') + '*'.repeat(letters.length);
        });

        const cleaned = working.replace(/\S+/g, (word) => {
            // Checked under both foldings - see `foldings` for why one is not
            // enough.
            if (!foldings(word).some((form) => terms.has(form))) {
                return word;
            }

            filtered = true;

            return '*'.repeat(Math.min(word.length, 8));
        });

        return { text: cleaned, filtered };
    };

    return { clean };
}

/** The shared instance. Callers that need their own list build one. */
const contentFilter = createContentFilter();

/** Convenience for the common case: mask and return the text. */
function filterText(text) {
    return contentFilter.clean(text).text;
}

module.exports = {
    createContentFilter,
    contentFilter,
    filterText,
    normalise,
    foldings,
    DEFAULT_TERMS
};
