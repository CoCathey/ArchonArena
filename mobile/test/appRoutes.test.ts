import { describe, expect, it } from 'vitest';
import { routeForSiteUrl } from '../src/appRoutes';

describe('routeForSiteUrl', () => {
    // The lobby's notices and every notification carry the website's path, and
    // the website pluralises where the app does not.
    it('maps the site tournament path onto the app screen', () => {
        expect(routeForSiteUrl('/tournaments/412')).toBe('/tournament/412');
    });

    it('keeps a message thread addressed by username', () => {
        expect(routeForSiteUrl('/messages/keyraider')).toBe('/messages/keyraider');
        expect(routeForSiteUrl('/messages')).toBe('/messages');
    });

    // The server percent-encodes the username on its way out; re-encoding it
    // here would turn a space into a literal '%20' in the thread it opens.
    it('passes an encoded username through untouched', () => {
        expect(routeForSiteUrl('/messages/two%20words')).toBe('/messages/two%20words');
    });

    // A query the website uses to pick a tab would otherwise stop the path
    // matching at all, and the notice would silently lose its button.
    it('ignores a query string and a fragment', () => {
        expect(routeForSiteUrl('/tournaments/9?tab=standings')).toBe('/tournament/9');
        expect(routeForSiteUrl('/tournaments/9#round-2')).toBe('/tournament/9');
    });

    // Anything else must come back undefined: pushing a route the app does not
    // have lands on expo-router's error page, which reads as a broken app —
    // worse than a notice with no button.
    it('refuses a path the app has no screen for', () => {
        expect(routeForSiteUrl('/decks/12')).toBeUndefined();
        expect(routeForSiteUrl('https://archonarena.com/tournaments/1')).toBeUndefined();
        expect(routeForSiteUrl(undefined)).toBeUndefined();
        expect(routeForSiteUrl(42)).toBeUndefined();
    });
});
