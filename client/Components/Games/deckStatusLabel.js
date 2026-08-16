/**
 * ARCHON: what to call a deck's status on the pre-game screen.
 *
 * The pending game used to collapse everything that was not perfectly clean
 * into one word - "Invalid" - which is a claim about legality. Most of these
 * states are not that. A deck more than one account owns is legal, playable
 * and rated; keyteki's own deck list has always called it Used, and the
 * pre-game screen calling the same deck Invalid told a player their legal deck
 * was barred from the game it was about to be played in. There is nothing they
 * could have done about it either, because the deck's owner does not choose who
 * else imports it.
 *
 * So: "Invalid" is reserved for a deck that genuinely cannot be played as it
 * stands, and everything else says what it actually is. Same vocabulary as
 * Decks/DeckStatus.jsx, so the two screens agree.
 *
 * Exported as a plain function rather than living in the component so it can be
 * tested without a renderer; `t` is passed in for the same reason.
 */

export const VALID_TONE =
    'text-emerald-700 bg-emerald-500/12 border-emerald-500/30 dark:text-emerald-300 dark:bg-emerald-500/10';

/** A deck that cannot be played as it stands. */
export const PROBLEM_TONE =
    'text-[color:color-mix(in_oklab,var(--brand)_85%,black)] bg-[color:color-mix(in_oklab,var(--brand)_12%,white)] border-[color:color-mix(in_oklab,var(--brand)_35%,transparent)] dark:text-rose-300 dark:bg-rose-500/10 dark:border-rose-500/30';

/** Something worth knowing about a deck that is perfectly playable. */
export const NOTE_TONE =
    'text-amber-700 bg-amber-500/12 border-amber-500/30 dark:text-amber-300 dark:bg-amber-500/10';

export const PENDING_TONE = 'text-foreground/75 bg-surface-secondary/35 border-border/50';

/**
 * @param {object} [status] The deck status the server sent, absent until a deck
 *   is chosen.
 * @param {function(string): string} t
 * @returns {{label: string, tone: string, hint?: string, playable: boolean}}
 */
export function describeDeckStatus(status, t) {
    if (!status) {
        return { label: t('Pending'), tone: PENDING_TONE, playable: true };
    }

    // Enhancements the owner has not assigned yet: the engine cannot build the
    // deck, so this one really does stop the game.
    if (!status.basicRules) {
        return {
            label: t('Invalid'),
            tone: PROBLEM_TONE,
            hint: t('This deck has enhancements that have not been assigned yet.'),
            playable: false
        };
    }

    if (!status.noUnreleasedCards) {
        return {
            label: t('Unreleased cards'),
            tone: PROBLEM_TONE,
            hint: t('This deck contains cards that are not released yet.'),
            playable: false
        };
    }

    if (status.notVerified) {
        return {
            label: t('Enhancements not verified'),
            tone: NOTE_TONE,
            hint: t("Nobody has confirmed this deck's enhancements against Master Vault yet."),
            playable: true
        };
    }

    if (status.impossible) {
        return {
            label: t('Casual only'),
            tone: NOTE_TONE,
            hint: t('A theoretical deck. Fine to play, but not a deck that exists.'),
            playable: true
        };
    }

    // Owned by more than one account. Allowed here, and off by default - see
    // lobby.flagSharedDecks - so this only ever appears where an operator has
    // deliberately asked to be told.
    if (!status.verified && status.usageLevel > 0) {
        const label =
            status.usageLevel === 1
                ? t('Used')
                : status.usageLevel === 2
                ? t('Popular')
                : t('Notorious');

        return {
            label,
            tone: NOTE_TONE,
            hint: t('More than one account owns this deck. It is still legal to play.'),
            playable: true
        };
    }

    return { label: t('Valid'), tone: VALID_TONE, playable: true };
}
