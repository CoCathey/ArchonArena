const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/**
 * ARCHON: the check-in kiosk has somewhere to land.
 *
 * The organizer opens check-in, prints the QR, and tapes it to the door.
 * CheckInKiosk encodes `/check-in/<code>` into it and the card beside it tells
 * players they can type the code at /check-in. Neither route was registered,
 * so every player who scanned that poster at a live event got the 404 page -
 * with the whole server side built, tested, and reachable by nothing. The RTK
 * mutation existed and was exported with zero consumers, which is the shape
 * this failure takes: every piece present except the last hop.
 *
 * A route table and the URL a printed poster carries are exactly the pair that
 * drifts apart silently, because nothing imports one from the other. This
 * checks they still agree.
 */
describe('check-in kiosk routing', function () {
    const kiosk = read('client/Components/Tournaments/CheckInKiosk.jsx');
    const routes = read('client/AppRoutes.jsx');
    const page = read('client/pages/CheckIn.jsx');

    it('points the QR at a path the router actually serves', function () {
        // The path the printed QR carries, as the kiosk builds it.
        const built = /\$\{window\.location\.origin\}(\/[a-z-]+)\//.exec(kiosk);

        expect(built, 'CheckInKiosk no longer builds a URL this test can read').toBeTruthy();

        const basePath = built[1];

        expect(routes).toContain(`path='${basePath}/:code'`);
        // And the typed-code form the card next to the QR advertises.
        expect(routes).toContain(`path='${basePath}'`);
    });

    it('reaches the endpoint that actually checks a player in', function () {
        expect(page).toContain('useCheckInByCodeMutation');
    });

    // Checking in marks the signed-in account present, so an anonymous scan
    // has to ask for a sign-in rather than silently doing nothing.
    it('asks an anonymous scanner to sign in', function () {
        expect(page).toMatch(/state\.account\.user/);
        expect(page).toMatch(/Sign in/);
    });

    it('sends a checked-in player to the event they just joined', function () {
        expect(page).toMatch(/navigate\(`\/tournaments\/\$\{result\.tournamentId\}`/);
    });
});
