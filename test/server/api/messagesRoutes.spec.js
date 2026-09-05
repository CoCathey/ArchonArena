/**
 * ARCHON: the direct message routes are registered, in an order that works,
 * and sending is bounded.
 *
 * Two things this catches that a service test cannot: a fixed path registered
 * after the ':username' routes ('conversations' read as somebody's name), and
 * a rate limiter written but not attached to the one route that notifies
 * another person.
 */
describe('direct message routes', function () {
    const registered = [];

    beforeAll(function () {
        const record =
            (method) =>
            (path, ...handlers) =>
                registered.push({ method, path, handlers });

        require('../../../server/api/messages.js').init({
            get: record('get'),
            post: record('post'),
            put: record('put'),
            patch: record('patch'),
            delete: record('delete'),
            use: () => {}
        });
    });

    const find = (method, path) =>
        registered.find((entry) => entry.method === method && entry.path === path);

    it('registers the inbox, the badge, the thread, sending and reading', function () {
        expect(find('get', '/api/messages/conversations')).toBeDefined();
        expect(find('get', '/api/messages/unread-count')).toBeDefined();
        expect(find('get', '/api/messages/with/:username')).toBeDefined();
        expect(find('post', '/api/messages/with/:username')).toBeDefined();
        expect(find('post', '/api/messages/with/:username/read')).toBeDefined();
    });

    it('keeps the moderator delete route it always had', function () {
        expect(find('delete', '/api/messages/:messageId')).toBeDefined();
    });

    it('registers the fixed paths before the username ones', function () {
        const order = registered.map((entry) => entry.path);

        expect(order.indexOf('/api/messages/conversations')).toBeLessThan(
            order.indexOf('/api/messages/with/:username')
        );
        expect(order.indexOf('/api/messages/unread-count')).toBeLessThan(
            order.indexOf('/api/messages/with/:username')
        );
    });

    it('bounds sending, which notifies another person', function () {
        // passport, the limiter, then the body: three handlers, not two.
        expect(find('post', '/api/messages/with/:username').handlers).toHaveLength(3);
    });

    it('does not bound reading', function () {
        expect(find('get', '/api/messages/with/:username').handlers).toHaveLength(2);
        expect(find('post', '/api/messages/with/:username/read').handlers).toHaveLength(2);
    });
});
