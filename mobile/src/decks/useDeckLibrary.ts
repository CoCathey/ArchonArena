import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchDecks, type DeckSort } from '../api/client';
import type { Deck } from '../api/types';

/** How long to sit on keystrokes before asking the server again. */
const SEARCH_DEBOUNCE_MS = 300;

export interface DeckSortOption {
    key: DeckSort;
    label: string;
    dir: 'asc' | 'desc';
}

/**
 * Sorts the server can actually order by. Anything not in
 * DeckService.mapColumn silently falls back to LastUpdated, so this list is
 * deliberately narrow.
 */
export const DECK_SORTS: DeckSortOption[] = [
    { key: 'lastUpdated', label: 'Recent', dir: 'desc' },
    { key: 'name', label: 'Name', dir: 'asc' },
    { key: 'sasRating', label: 'SAS', dir: 'desc' },
    { key: 'winRate', label: 'Win %', dir: 'desc' }
];

/**
 * The caller's deck collection, paged. Search, house filter and sort all run
 * server-side, so they apply to the whole collection rather than to whichever
 * page happens to be loaded — a search that only looked at the first page would
 * confidently report "no decks" for a deck the player owns.
 */
export function useDeckLibrary(options: { pageSize?: number; enabled?: boolean } = {}) {
    const pageSize = options.pageSize ?? 40;
    const enabled = options.enabled !== false;

    const [decks, setDecks] = useState<Deck[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState<DeckSortOption>(DECK_SORTS[0]);
    const [houses, setHouses] = useState<string[]>([]);

    // Only the newest request may write results: filters change faster than
    // the network answers, and a slow earlier page must not overwrite them.
    const requestId = useRef(0);

    useEffect(() => {
        const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [searchInput]);

    const fetchPage = useCallback(
        async (targetPage: number) => {
            const id = ++requestId.current;
            if (targetPage === 1) {
                setLoading(true);
            } else {
                setLoadingMore(true);
            }
            setError(undefined);
            try {
                const result = await fetchDecks({
                    page: targetPage,
                    pageSize,
                    sort: sort.key,
                    sortDir: sort.dir,
                    search,
                    houses
                });
                if (id !== requestId.current) {
                    return;
                }
                const incoming = result.decks ?? [];
                setTotal(result.numDecks ?? incoming.length);
                setPage(targetPage);
                setDecks((previous) => {
                    if (targetPage === 1) {
                        return incoming;
                    }
                    // Guard against a deck arriving twice if the collection
                    // shifted under us between pages.
                    const seen = new Set(previous.map((deck) => String(deck.id)));
                    return previous.concat(incoming.filter((deck) => !seen.has(String(deck.id))));
                });
            } catch (err) {
                if (id !== requestId.current) {
                    return;
                }
                setError(err instanceof Error ? err.message : 'Could not load decks');
            } finally {
                if (id === requestId.current) {
                    setLoading(false);
                    setLoadingMore(false);
                }
            }
        },
        [houses, pageSize, search, sort]
    );

    useEffect(() => {
        if (enabled) {
            fetchPage(1);
        }
    }, [enabled, fetchPage]);

    const hasMore = decks.length < total;

    const loadMore = useCallback(() => {
        if (!loading && !loadingMore && hasMore) {
            fetchPage(page + 1);
        }
    }, [fetchPage, hasMore, loading, loadingMore, page]);

    const toggleHouse = useCallback((house: string) => {
        setHouses((previous) =>
            previous.includes(house)
                ? previous.filter((entry) => entry !== house)
                : previous.concat(house)
        );
    }, []);

    const clearFilters = useCallback(() => {
        setSearchInput('');
        setSearch('');
        setHouses([]);
    }, []);

    const filtered = search.length > 0 || houses.length > 0;

    return useMemo(
        () => ({
            decks,
            total,
            loading,
            loadingMore,
            hasMore,
            error,
            filtered,
            searchInput,
            setSearchInput,
            sort,
            setSort,
            houses,
            toggleHouse,
            clearFilters,
            loadMore,
            refresh: () => fetchPage(1)
        }),
        [
            clearFilters,
            decks,
            error,
            fetchPage,
            filtered,
            hasMore,
            houses,
            loadMore,
            loading,
            loadingMore,
            searchInput,
            sort,
            toggleHouse,
            total
        ]
    );
}
