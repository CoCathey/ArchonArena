import React, { useMemo, useState } from 'react';
import moment from 'moment';
import { Button as HeroButton } from '@heroui/react';

import AlertPanel from '../Components/Site/AlertPanel';
import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import PlayerName from '../Components/Site/PlayerName';
import { useGetUserGamesQuery, useGetGameFiltersQuery } from '../redux/api';

import { Trans, useTranslation } from 'react-i18next';

const computeKeys = (player) => {
    if (player.keys === null || player.keys === undefined) {
        return 0;
    }

    if (!isNaN(player.keys)) {
        return player.keys;
    }

    return player.keys.yellow + player.keys.blue + player.keys.red;
};

const computeWinner = (game) => {
    if (
        !game.winner ||
        game.winner === game.players[0].name ||
        game.winner === game.players[1].name
    ) {
        return game.winner;
    }

    if (game.winner === game.players[0].deck) {
        return game.players[0].name;
    }

    if (game.winner === game.players[1].deck) {
        return game.players[1].name;
    }
};

const EMPTY_FILTERS = { deck: '', opponent: '', format: '', result: '' };

const Matches = () => {
    const { t } = useTranslation();
    const [filters, setFilters] = useState(EMPTY_FILTERS);

    // Only send the filters that are set - an empty string would be a filter
    // for "format is empty string", not "any format".
    const query = useMemo(
        () => Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
        [filters]
    );

    const {
        data: gamesResponse,
        isLoading,
        isFetching,
        isError,
        error
    } = useGetUserGamesQuery(query);
    // ARCHON (N1): the decks, opponents and formats this player has actually
    // played, so the controls offer real choices rather than the site-wide list
    // and a free-text box to guess into.
    const { data: filterOptions } = useGetGameFiltersQuery();

    const games =
        gamesResponse?.games?.filter(
            (game) =>
                game.players && game.players.length === 2 && game.decks && game.decks.length === 2
        ) || [];

    const hasFilters = Object.keys(query).length > 0;
    const setFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));

    const selectClass =
        'rounded-md border border-border/70 bg-surface px-2 py-1 text-sm text-foreground';

    const filterBar = (
        <div className='mb-3 flex flex-wrap items-center gap-2'>
            <select
                className={selectClass}
                value={filters.deck}
                aria-label={t('Filter by deck')}
                onChange={(event) => setFilter('deck', event.target.value)}
            >
                <option value=''>{t('Any deck')}</option>
                {(filterOptions?.decks || []).map((deck) => (
                    <option key={deck.identity} value={deck.identity}>
                        {deck.name} ({deck.games})
                    </option>
                ))}
            </select>

            <select
                className={selectClass}
                value={filters.opponent}
                aria-label={t('Filter by opponent')}
                onChange={(event) => setFilter('opponent', event.target.value)}
            >
                <option value=''>{t('Any opponent')}</option>
                {(filterOptions?.opponents || []).map((opponent) => (
                    <option key={opponent.username} value={opponent.username}>
                        {opponent.username} ({opponent.games})
                    </option>
                ))}
            </select>

            <select
                className={selectClass}
                value={filters.format}
                aria-label={t('Filter by format')}
                onChange={(event) => setFilter('format', event.target.value)}
            >
                <option value=''>{t('Any format')}</option>
                {(filterOptions?.formats || []).map((format) => (
                    <option key={format} value={format}>
                        {t(format)}
                    </option>
                ))}
            </select>

            <select
                className={selectClass}
                value={filters.result}
                aria-label={t('Filter by result')}
                onChange={(event) => setFilter('result', event.target.value)}
            >
                <option value=''>{t('Any result')}</option>
                <option value='win'>{t('Wins')}</option>
                <option value='loss'>{t('Losses')}</option>
            </select>

            {hasFilters && (
                <HeroButton size='sm' variant='tertiary' onPress={() => setFilters(EMPTY_FILTERS)}>
                    {t('Clear filters')}
                </HeroButton>
            )}

            {isFetching && <span className='text-xs text-muted'>{t('Loading…')}</span>}
        </div>
    );

    if (isLoading) {
        return (
            <div>
                <Trans>Loading matches from the server...</Trans>
            </div>
        );
    }

    if (isError) {
        return (
            <div className='profile mx-auto min-h-full w-full max-w-6xl'>
                <Panel title={t('Matches')}>
                    <AlertPanel
                        type='error'
                        message={
                            error?.data?.message ||
                            t('Could not load your game history. Please try again in a moment.')
                        }
                    />
                </Panel>
            </div>
        );
    }

    const matches = games
        ? games.map((game) => {
              const startedAt = moment(game.startedAt);
              const finishedAt = moment(game.finishedAt);
              const duration = moment.duration(finishedAt.diff(startedAt));

              const myKeys = computeKeys(game.players[0]);
              const oppKeys = computeKeys(game.players[1]);

              return (
                  <tr key={game.gameId}>
                      <td>{game.decks[0].name}</td>
                      <td className='whitespace-nowrap'>
                          <PlayerName
                              className='hover:text-amber-300'
                              link
                              username={game.players[1].name}
                          />
                      </td>
                      <td>{game.decks[1].name}</td>
                      <td>{computeWinner(game)}</td>
                      <td className='whitespace-nowrap'>{t(game.winReason)}</td>
                      <td className='whitespace-nowrap'>
                          {myKeys} x {oppKeys}
                      </td>
                      <td className='whitespace-nowrap'>{t(game.gameFormat)}</td>
                      <td className='whitespace-nowrap'>
                          {moment(game.startedAt).format('YYYY-MM-DD HH:mm')}
                      </td>
                      <td className='whitespace-nowrap'>
                          {duration.get('minutes')}m {duration.get('seconds')}s
                      </td>
                      <td className='whitespace-nowrap'>
                          <Link
                              href={`/replay/${game.gameId}`}
                              className='text-amber-300 underline'
                          >
                              {t('Replay')}
                          </Link>
                      </td>
                  </tr>
              );
          })
        : null;

    const table =
        games && games.length === 0 ? (
            <div className='text-sm text-muted'>
                {hasFilters
                    ? t('No matches fit those filters.')
                    : t('You have no recorded matches.')}
            </div>
        ) : (
            <table className='w-full border-collapse text-left text-sm text-zinc-100'>
                <thead>
                    <tr className='border-b border-zinc-600/70'>
                        <th className='px-2 py-2 font-semibold'>
                            <Trans>My Deck</Trans>
                        </th>
                        <th className='px-2 py-2 font-semibold'>
                            <Trans>Opponent</Trans>
                        </th>
                        <th className='px-2 py-2 font-semibold'>
                            <Trans>Opponent&apos;s Deck</Trans>
                        </th>
                        <th className='px-2 py-2 font-semibold'>
                            <Trans>Winner</Trans>
                        </th>
                        <th className='px-2 py-2 font-semibold'>
                            <Trans>Reason</Trans>
                        </th>
                        <th className='px-2 py-2 font-semibold'>
                            <Trans>Keys</Trans>
                        </th>
                        <th className='px-2 py-2 font-semibold'>
                            <Trans>Format</Trans>
                        </th>
                        <th className='px-2 py-2 font-semibold'>
                            <Trans>Started At</Trans>
                        </th>
                        <th className='px-2 py-2 font-semibold'>
                            <Trans>Duration</Trans>
                        </th>
                        <th className='px-2 py-2 font-semibold'>
                            <Trans>Replay</Trans>
                        </th>
                    </tr>
                </thead>
                <tbody className='[&>tr:nth-child(odd)]:bg-black/20 [&>tr>td]:px-2 [&>tr>td]:py-1.5'>
                    {matches}
                </tbody>
            </table>
        );

    return (
        <div className='profile mx-auto min-h-full w-full max-w-6xl'>
            <Panel title={t('Matches')}>
                {filterBar}
                {table}
            </Panel>
        </div>
    );
};

Matches.displayName = 'Matches';

export default Matches;
