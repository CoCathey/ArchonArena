import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Label, toast } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import {
    useCreateInPersonGameMutation,
    useGetDecksQuery,
    useGetInPersonGamesQuery,
    useInPersonGameActionMutation
} from '../redux/api';

const inputClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none';

const STATUS_LABELS = {
    pending: 'Waiting on reports',
    confirmed: 'Confirmed',
    disputed: 'Reports disagree',
    cancelled: 'Cancelled'
};

/**
 * ARCHON (N13): report a game played across a table.
 *
 * The form deliberately never pre-fills what the other player said. Both
 * players are asked what happened, independently; agreeing reports commit and
 * a mismatch becomes a visible dispute. Showing one player the other's answer
 * would turn "report" into "confirm", which is a much weaker claim.
 */
const ReportForm = ({ game, onDone }) => {
    const { t } = useTranslation();
    const [winnerId, setWinnerId] = useState(game.player1.id);
    const [player1Keys, setPlayer1Keys] = useState(3);
    const [player2Keys, setPlayer2Keys] = useState(0);
    const [player1DeckId, setPlayer1DeckId] = useState('');
    const [player2DeckId, setPlayer2DeckId] = useState('');
    const { data: decks } = useGetDecksQuery({});
    const [action, { isLoading }] = useInPersonGameActionMutation();

    const myDecks = decks?.decks || [];

    const submit = async () => {
        try {
            const result = await action({
                id: game.id,
                action: 'report',
                body: {
                    winnerId,
                    player1Keys: Number(player1Keys),
                    player2Keys: Number(player2Keys),
                    player1DeckId: player1DeckId || null,
                    player2DeckId: player2DeckId || null
                }
            }).unwrap();

            if (!result.success) {
                toast.danger(result.message || t('Could not file the report'));

                return;
            }

            if (result.status === 'confirmed') {
                toast.success(
                    result.rated
                        ? t('Game confirmed and rated')
                        : t('Game confirmed. {{reason}}', {
                              reason: result.unratedReason || t('It was not rated.')
                          })
                );
            } else if (result.status === 'disputed') {
                toast.danger(t('Your reports do not match - both of you can re-report'));
            } else {
                toast.success(t('Report filed - waiting on your opponent'));
            }

            onDone();
        } catch {
            toast.danger(t('Could not file the report'));
        }
    };

    return (
        <div className='mt-2 space-y-2 rounded-md border border-border/60 bg-surface-secondary/40 p-3'>
            <div>
                <Label>{t('Who won?')}</Label>
                <select
                    className={inputClass}
                    value={winnerId}
                    onChange={(event) => setWinnerId(Number(event.target.value))}
                >
                    <option value={game.player1.id}>{game.player1.username}</option>
                    <option value={game.player2.id}>{game.player2.username}</option>
                </select>
            </div>
            <div className='grid grid-cols-2 gap-2'>
                <div>
                    <Label>{t("{{name}}'s keys", { name: game.player1.username })}</Label>
                    <input
                        type='number'
                        min={0}
                        max={10}
                        className={inputClass}
                        value={player1Keys}
                        onChange={(event) => setPlayer1Keys(event.target.value)}
                    />
                </div>
                <div>
                    <Label>{t("{{name}}'s keys", { name: game.player2.username })}</Label>
                    <input
                        type='number'
                        min={0}
                        max={10}
                        className={inputClass}
                        value={player2Keys}
                        onChange={(event) => setPlayer2Keys(event.target.value)}
                    />
                </div>
            </div>
            <div className='grid grid-cols-2 gap-2'>
                <div>
                    <Label>{t("{{name}}'s deck", { name: game.player1.username })}</Label>
                    <select
                        className={inputClass}
                        value={player1DeckId}
                        onChange={(event) => setPlayer1DeckId(event.target.value)}
                    >
                        <option value=''>{t('Not recorded')}</option>
                        {myDecks.map((deck) => (
                            <option key={deck.id} value={deck.id}>
                                {deck.name}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <Label>{t("{{name}}'s deck", { name: game.player2.username })}</Label>
                    <select
                        className={inputClass}
                        value={player2DeckId}
                        onChange={(event) => setPlayer2DeckId(event.target.value)}
                    >
                        <option value=''>{t('Not recorded')}</option>
                        {myDecks.map((deck) => (
                            <option key={deck.id} value={deck.id}>
                                {deck.name}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
            <p className='text-xs text-muted'>
                {t(
                    'You can only attach decks from your own collection - your opponent attaches theirs. Both decks must be attached for a game to be rated, because the rating needs each deck’s SAS.'
                )}
            </p>
            <HeroButton size='sm' variant='primary' isPending={isLoading} onPress={submit}>
                {t('File report')}
            </HeroButton>
        </div>
    );
};

const InPersonGames = () => {
    const { t } = useTranslation();
    const [opponentUsername, setOpponentUsername] = useState('');
    const [gameFormat, setGameFormat] = useState('archon');
    const [reportingId, setReportingId] = useState(null);
    const { data, refetch } = useGetInPersonGamesQuery({});
    const [createGame] = useCreateInPersonGameMutation();
    const [action] = useInPersonGameActionMutation();

    const onCreate = async () => {
        try {
            const result = await createGame({ opponentUsername, gameFormat }).unwrap();

            if (result.success) {
                toast.success(t('Game recorded - now both of you report the result'));
                setOpponentUsername('');
                setReportingId(result.id);
                refetch();
            } else {
                toast.danger(result.message || t('Could not record the game'));
            }
        } catch {
            toast.danger(t('Could not record the game'));
        }
    };

    const simpleAction = async (id, name, message) => {
        try {
            const result = await action({ id, action: name, body: {} }).unwrap();

            if (result.success) {
                toast.success(message);
                refetch();
            } else {
                toast.danger(result.message || t('Action failed'));
            }
        } catch {
            toast.danger(t('Action failed'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            <Panel title={t('In-person games')}>
                <p className='mb-3 text-xs text-muted'>
                    {data?.rated
                        ? t(
                              'Games played across a table count toward your Amber once both players report the same result.'
                          )
                        : t(
                              'Games played across a table are recorded in your history once both players report the same result. They do not currently affect Amber.'
                          )}
                </p>
                <div className='flex flex-wrap gap-2'>
                    <input
                        type='text'
                        className={inputClass + ' !w-56'}
                        placeholder={t('Opponent username')}
                        value={opponentUsername}
                        onChange={(event) => setOpponentUsername(event.target.value)}
                    />
                    <select
                        className={inputClass + ' !w-40'}
                        value={gameFormat}
                        onChange={(event) => setGameFormat(event.target.value)}
                    >
                        <option value='archon'>{t('Archon')}</option>
                        <option value='sealed'>{t('Sealed')}</option>
                        <option value='alliance'>{t('Alliance')}</option>
                    </select>
                    <HeroButton
                        size='sm'
                        variant='primary'
                        isDisabled={!opponentUsername.trim()}
                        onPress={onCreate}
                    >
                        {t('Record a game')}
                    </HeroButton>
                </div>
            </Panel>

            <Panel title={t('Your games')}>
                <div className='space-y-2'>
                    {(data?.games || []).map((game) => (
                        <div
                            key={game.id}
                            className='rounded-md border border-border/50 bg-surface-secondary/40 p-2'
                        >
                            <div className='flex flex-wrap items-center gap-2 text-sm'>
                                <span className='font-semibold text-foreground'>
                                    {game.player1.username} {t('vs')} {game.player2.username}
                                </span>
                                <span className='text-xs capitalize text-muted'>
                                    {game.gameFormat}
                                </span>
                                <span
                                    className={
                                        game.status === 'disputed'
                                            ? 'rounded bg-red-500/20 px-1.5 text-xs text-red-300'
                                            : 'rounded bg-surface-secondary/70 px-1.5 text-xs text-muted'
                                    }
                                >
                                    {t(STATUS_LABELS[game.status] || game.status)}
                                </span>
                                {game.status === 'confirmed' && !game.rated && (
                                    <span
                                        className='text-xs text-muted'
                                        title={game.unratedReason || ''}
                                    >
                                        {t('(unrated)')}
                                    </span>
                                )}
                                <span className='ml-auto flex gap-1'>
                                    {game.awaitingMyReport && game.status !== 'cancelled' && (
                                        <HeroButton
                                            size='sm'
                                            variant='primary'
                                            className='!h-6 !px-2 text-xs'
                                            onPress={() =>
                                                setReportingId(
                                                    reportingId === game.id ? null : game.id
                                                )
                                            }
                                        >
                                            {t('Report')}
                                        </HeroButton>
                                    )}
                                    {game.status === 'disputed' && !game.awaitingMyReport && (
                                        <HeroButton
                                            size='sm'
                                            variant='tertiary'
                                            className='!h-6 !px-2 text-xs'
                                            onPress={() =>
                                                simpleAction(
                                                    game.id,
                                                    'withdraw',
                                                    t('Report withdrawn - report again')
                                                )
                                            }
                                        >
                                            {t('Re-report')}
                                        </HeroButton>
                                    )}
                                    {game.status === 'pending' && (
                                        <HeroButton
                                            size='sm'
                                            variant='tertiary'
                                            className='!h-6 !px-2 text-xs'
                                            onPress={() =>
                                                simpleAction(game.id, 'cancel', t('Game cancelled'))
                                            }
                                        >
                                            {t('Cancel')}
                                        </HeroButton>
                                    )}
                                </span>
                            </div>
                            {game.status === 'disputed' && (
                                <div className='mt-1 flex flex-wrap items-center gap-2'>
                                    <p className='text-xs text-muted'>
                                        {game.reportId
                                            ? t(
                                                  'Nothing was recorded. A moderator is looking at this.'
                                              )
                                            : t(
                                                  'Nothing was recorded. Talk it over, then one of you can withdraw and re-report.'
                                              )}
                                    </p>
                                    {/* ARCHON (N5): escalate when the two of
                                        you cannot settle it. Player-initiated
                                        on purpose - most disagreements are a
                                        mistyped key count, and routing every
                                        one into the queue would bury the
                                        reports that matter. */}
                                    {!game.reportId && (
                                        <HeroButton
                                            size='sm'
                                            variant='tertiary'
                                            className='!h-6 !px-2 text-xs'
                                            onPress={() =>
                                                simpleAction(
                                                    game.id,
                                                    'escalate',
                                                    t('Sent to the moderators')
                                                )
                                            }
                                        >
                                            {t('Ask a moderator')}
                                        </HeroButton>
                                    )}
                                </div>
                            )}
                            {reportingId === game.id && game.awaitingMyReport && (
                                <ReportForm
                                    game={game}
                                    onDone={() => {
                                        setReportingId(null);
                                        refetch();
                                    }}
                                />
                            )}
                        </div>
                    ))}
                    {data?.games?.length === 0 && (
                        <div className='text-sm text-muted'>
                            {t('No in-person games recorded yet.')}
                        </div>
                    )}
                </div>
            </Panel>
        </div>
    );
};

InPersonGames.displayName = 'InPersonGames';

export default InPersonGames;
