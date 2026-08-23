const GameRouter = require('../../server/gamerouter.js');

/**
 * ARCHON (N50): filing a finished practice game against the champion.
 *
 * This is the router's half of the human ladder, and everything it has to get
 * right is a way of attributing a result to the wrong thing:
 *
 *  - a game where the bot's seat was never identified would be filed against
 *    whoever the first player happened to be,
 *  - a bot-versus-bot showcase has no human seat to file it against at all,
 *  - a concession or an abandonment is not evidence about play (the practice
 *    bot concedes ITSELF past its own safety caps), and
 *  - an ordinary game between two people is not a measurement of the bot.
 *
 * Each of those would produce a number that looks exactly as trustworthy as a
 * real one, which is why they are pinned here rather than left to the reader.
 */
const buildRouter = () => {
    const filed = [];

    // Object.create rather than `new`: the constructor connects to Redis.
    const router = Object.create(GameRouter.prototype);

    router.policyService = {
        recordHumanGame: async () => true,
        recordHumanLadderGame: async (entry) => {
            filed.push(entry);

            return true;
        }
    };

    return { router, filed };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A finished practice table: one bot seat, one person. */
const practiceGame = (overrides = {}) => ({
    game: {
        gameId: 'uuid-1',
        botGame: true,
        players: [{ name: 'Snudge' }, { name: 'cathey' }],
        ...(overrides.game || {})
    },
    winner: 'cathey',
    reason: 'keys',
    botSeats: ['Snudge'],
    botPolicyVersion: 12,
    ...overrides
});

describe('filing a practice game on the human ladder', function () {
    it('names the human seat, the model that played, and who won', async function () {
        const { router, filed } = buildRouter();

        router.recordHumanLadderGame(practiceGame());
        await settle();

        expect(filed).toEqual([{ username: 'cathey', botWon: false, policyVersion: 12 }]);
    });

    it('records a bot win as a bot win', async function () {
        const { router, filed } = buildRouter();

        router.recordHumanLadderGame(practiceGame({ winner: 'Snudge' }));
        await settle();

        expect(filed[0].botWon).toBe(true);
    });

    it('leaves an ordinary game between two people alone', async function () {
        const { router, filed } = buildRouter();

        router.recordHumanLadderGame(
            practiceGame({
                game: { botGame: undefined, players: [{ name: 'a' }, { name: 'b' }] },
                botSeats: []
            })
        );
        await settle();

        expect(filed).toEqual([]);
    });

    it('leaves a concession and an abandonment alone', async function () {
        const { router, filed } = buildRouter();

        router.recordHumanLadderGame(practiceGame({ reason: 'concede' }));
        router.recordHumanLadderGame(practiceGame({ reason: 'abandoned' }));
        await settle();

        expect(filed).toEqual([]);
    });

    it('keeps a game the clock decided', async function () {
        const { router, filed } = buildRouter();

        router.recordHumanLadderGame(practiceGame({ reason: 'keys after time' }));
        await settle();

        expect(filed.length).toBe(1);
    });

    it('refuses to guess when the bot seat was never identified', async function () {
        const { router, filed } = buildRouter();

        // Without `botSeats` both names look human, and filing this would
        // credit the game to whichever seat came first in the list.
        router.recordHumanLadderGame(practiceGame({ botSeats: undefined }));
        await settle();

        expect(filed).toEqual([]);
    });

    it('files nothing for a bot-versus-bot table', async function () {
        const { router, filed } = buildRouter();

        router.recordHumanLadderGame(
            practiceGame({
                game: { botGame: true, players: [{ name: 'Snudge' }, { name: 'Tunk' }] },
                botSeats: ['Snudge', 'Tunk'],
                winner: 'Tunk'
            })
        );
        await settle();

        expect(filed).toEqual([]);
    });

    it('survives a payload with no game on it', function () {
        const { router, filed } = buildRouter();

        expect(() => router.recordHumanLadderGame(undefined)).not.toThrow();
        expect(() => router.recordHumanLadderGame({})).not.toThrow();
        expect(filed).toEqual([]);
    });

    it('never lets a ladder write reject into the game flow', async function () {
        const { router } = buildRouter();

        router.policyService.recordHumanLadderGame = async () => {
            throw new Error('the diary is on fire');
        };

        expect(() => router.recordHumanLadderGame(practiceGame())).not.toThrow();
        await settle();
    });
});
