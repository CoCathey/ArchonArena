import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * ARCHON: elimination bracket visualization. Winners rounds render as
 * columns left to right (with the grand final last); double elim shows
 * the losers bracket below. Slots not yet decided show TBD; winners
 * are highlighted, walkovers marked.
 */

const SlotName = ({ name, isWinner, isMe }) => (
    <span
        className={`truncate text-sm ${
            isWinner ? 'font-bold text-amber-300' : name ? 'text-foreground' : 'italic text-muted'
        } ${isMe ? 'underline decoration-amber-400/70 underline-offset-2' : ''}`}
    >
        {name || 'TBD'}
    </span>
);
SlotName.displayName = 'BracketSlotName';

const MatchBox = ({ match, currentUsername, t }) => {
    const decided = !!match.winnerId || !!match.resultType;
    const showScores = match.bestOf > 1 && (match.player1Wins > 0 || match.player2Wins > 0);

    return (
        <div
            className={`w-44 rounded-md border px-2 py-1.5 ${
                decided
                    ? 'border-border/60 bg-surface-secondary/40'
                    : 'border-amber-400/40 bg-surface-secondary/70'
            }`}
        >
            <div className='flex items-center justify-between gap-2'>
                <SlotName
                    name={match.player1}
                    isWinner={match.winnerId && match.winnerId === match.player1Id}
                    isMe={match.player1 === currentUsername}
                />
                {showScores && <span className='text-xs text-muted'>{match.player1Wins}</span>}
            </div>
            {match.resultType === 'bye' ? (
                <div className='text-xs italic text-muted'>{t('bye')}</div>
            ) : (
                <div className='flex items-center justify-between gap-2'>
                    <SlotName
                        name={match.player2}
                        isWinner={match.winnerId && match.winnerId === match.player2Id}
                        isMe={match.player2 === currentUsername}
                    />
                    {showScores && <span className='text-xs text-muted'>{match.player2Wins}</span>}
                </div>
            )}
            {['forfeit', 'no-show'].includes(match.resultType) && (
                <div className='text-xs italic text-muted'>{t(match.resultType)}</div>
            )}
        </div>
    );
};
MatchBox.displayName = 'BracketMatchBox';

const BracketColumn = ({ title, matches, currentUsername, t }) => (
    <div className='flex flex-col'>
        <div className='mb-2 text-center text-xs uppercase tracking-wide text-muted'>{title}</div>
        <div className='flex flex-1 flex-col justify-around gap-3'>
            {matches.map((match) => (
                <MatchBox key={match.id} match={match} currentUsername={currentUsername} t={t} />
            ))}
        </div>
    </div>
);
BracketColumn.displayName = 'BracketColumn';

const roundTitle = (t, bracketRound, maxRound, prefix = '') => {
    if (bracketRound === maxRound) {
        return prefix ? `${prefix} ${t('Final')}` : t('Final');
    }

    if (bracketRound === maxRound - 1 && !prefix) {
        return t('Semifinals');
    }

    return `${prefix ? `${prefix} ` : ''}${t('Round {{round}}', { round: bracketRound })}`;
};

const BracketView = ({ matches, currentUsername }) => {
    const { t } = useTranslation();

    const bracketMatches = matches.filter((match) => match.bracket);

    if (bracketMatches.length === 0) {
        return null;
    }

    const byBracket = (bracket) =>
        bracketMatches
            .filter((match) => match.bracket === bracket)
            .sort(
                (a, b) =>
                    (a.bracketRound || 0) - (b.bracketRound || 0) ||
                    (a.bracketPos || 0) - (b.bracketPos || 0)
            );

    const winners = byBracket('W');
    const losers = byBracket('L');
    const finals = byBracket('GF');

    const groupByRound = (list) => {
        const rounds = new Map();

        for (const match of list) {
            const key = match.bracketRound || 1;
            if (!rounds.has(key)) {
                rounds.set(key, []);
            }
            rounds.get(key).push(match);
        }

        return [...rounds.entries()].sort((a, b) => a[0] - b[0]);
    };

    const winnersRounds = groupByRound(winners);
    const losersRounds = groupByRound(losers);
    const maxWinnersRound = winnersRounds.length ? winnersRounds[winnersRounds.length - 1][0] : 0;
    const maxLosersRound = losersRounds.length ? losersRounds[losersRounds.length - 1][0] : 0;
    const hasLosers = losersRounds.length > 0;

    return (
        <div className='space-y-4 overflow-x-auto pb-2'>
            <div className='flex items-stretch gap-4'>
                {winnersRounds.map(([round, roundMatches]) => (
                    <BracketColumn
                        key={`W${round}`}
                        title={roundTitle(t, round, maxWinnersRound, hasLosers ? t('Winners') : '')}
                        matches={roundMatches}
                        currentUsername={currentUsername}
                        t={t}
                    />
                ))}
                {finals.map((match) => (
                    <BracketColumn
                        key={match.id}
                        title={match.bracketRound === 2 ? t('Grand Final Reset') : t('Grand Final')}
                        matches={[match]}
                        currentUsername={currentUsername}
                        t={t}
                    />
                ))}
            </div>
            {hasLosers && (
                <div className='flex items-stretch gap-4 border-t border-border/50 pt-3'>
                    {losersRounds.map(([round, roundMatches]) => (
                        <BracketColumn
                            key={`L${round}`}
                            title={roundTitle(t, round, maxLosersRound, t('Losers'))}
                            matches={roundMatches}
                            currentUsername={currentUsername}
                            t={t}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

BracketView.displayName = 'BracketView';

export default BracketView;
