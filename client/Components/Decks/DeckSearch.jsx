import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';
import debounce from 'lodash.debounce';

import { Constants } from '../../constants';
import { useSaveDeckMutation, useSearchDeckCatalogQuery } from '../../redux/api';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 350;

const expansionLabel = (expansion) =>
    Constants.Expansions.find((candidate) => candidate.value === String(expansion))?.label ||
    String(expansion);

/**
 * ARCHON: find a deck by name instead of by link.
 *
 * Master Vault has no way to look a deck up by name and no per-user deck
 * endpoint, so until now the only way to add a deck was to paste its uuid.
 * The catalog crawl (docs/design/deck-catalog.md) indexes name -> uuid for
 * every deck that exists, which turns "I know what my deck is called" into a
 * working import.
 *
 * Only the catalog row is local. Picking a result imports through the ordinary
 * single-deck endpoint, so the deck itself still comes from Master Vault and
 * goes through the same parser as every other import.
 *
 * @param {{ onImported?: () => void }} props
 */
const DeckSearch = ({ onImported }) => {
    const { t } = useTranslation();

    const [typed, setTyped] = useState('');
    const [query, setQuery] = useState('');
    const [importing, setImporting] = useState(null);
    const [imported, setImported] = useState({});
    const [message, setMessage] = useState(null);

    const [saveDeck] = useSaveDeckMutation();

    const { data, isFetching } = useSearchDeckCatalogQuery(
        { q: query },
        { skip: query.length < MIN_QUERY_LENGTH }
    );

    const pushQuery = useMemo(() => debounce((next) => setQuery(next), DEBOUNCE_MS), []);

    const onType = useCallback(
        (event) => {
            const next = event.target.value;
            setTyped(next);
            pushQuery(next.trim());
        },
        [pushQuery]
    );

    const importDeck = async (deck) => {
        setMessage(null);
        setImporting(deck.uuid);

        try {
            const result = await saveDeck({ uuid: deck.uuid }).unwrap();
            if (result.success) {
                setImported((current) => ({ ...current, [deck.uuid]: true }));
                onImported?.();
            } else {
                setMessage(result.message || t('That deck could not be imported.'));
            }
        } catch (err) {
            // A deck the player already owns comes back as a rejection here,
            // not as success:false - treat it as done rather than as an error.
            if (/already exists/i.test(err?.data?.message || '')) {
                setImported((current) => ({ ...current, [deck.uuid]: true }));
            } else {
                setMessage(err?.data?.message || t('That deck could not be imported.'));
            }
        } finally {
            setImporting(null);
        }
    };

    const decks = data?.decks || [];
    const searchable = query.length >= MIN_QUERY_LENGTH;
    const searchOff = data && data.success === false;

    return (
        <div className='space-y-3'>
            <p className='text-sm text-muted'>
                {t("Know your deck's name? Search for it instead of pasting a link.")}
            </p>

            <input
                className='w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none'
                placeholder={t('Search decks by name')}
                value={typed}
                onChange={onType}
            />

            {searchOff && (
                <p className='text-sm text-muted'>{t('Deck search is turned off right now.')}</p>
            )}

            {!searchOff && searchable && isFetching && (
                <p className='text-xs text-muted'>{t('Searching…')}</p>
            )}

            {/* Two different nothings. The deck index is built by a crawl that
                is off until an operator turns it on, so the ordinary state of a
                fresh server is an empty table - and telling someone their deck
                "wasn't found, try later" sends them back to a search that can
                never succeed. */}
            {!searchOff && searchable && !isFetching && decks.length === 0 && (
                <p className='text-sm text-muted'>
                    {data?.catalogEmpty
                        ? t(
                              'Deck search is not available on this server yet — no decks have been indexed. Use your Decks of KeyForge key or a deck link above.'
                          )
                        : t(
                              'No decks found with that name. Newly registered decks can take a while to appear.'
                          )}
                </p>
            )}

            {decks.length > 0 && (
                <ul className='max-h-64 space-y-1 overflow-y-auto'>
                    {decks.map((deck) => {
                        const done = deck.owned || imported[deck.uuid];

                        return (
                            <li
                                key={deck.uuid}
                                className='flex items-center justify-between gap-3 rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2'
                            >
                                <div className='min-w-0'>
                                    <p className='truncate text-sm text-foreground'>{deck.name}</p>
                                    <p className='truncate text-xs text-muted'>
                                        {expansionLabel(deck.expansion)}
                                        {deck.houses
                                            ? ` • ${deck.houses.replace(/,/g, ' • ')}`
                                            : ''}
                                    </p>
                                </div>
                                <HeroButton
                                    size='sm'
                                    variant={done ? 'tertiary' : 'primary'}
                                    isDisabled={done || importing === deck.uuid}
                                    isPending={importing === deck.uuid}
                                    onPress={() => importDeck(deck)}
                                >
                                    {done ? t('Imported') : t('Import')}
                                </HeroButton>
                            </li>
                        );
                    })}
                </ul>
            )}

            {message && <p className='text-sm text-red-400'>{message}</p>}
        </div>
    );
};

DeckSearch.displayName = 'DeckSearch';

export default DeckSearch;
