import type { GameState } from '../game/types';

/**
 * What the game node sends alongside a `gamestate` payload.
 *
 * The node sends a player either a complete board or a jsondiffpatch delta over
 * the same event, and which one it is depends on state the client cannot see:
 * the node's per-player diff baseline, which it resets whenever that player
 * connects, reconnects, disconnects or leaves. `full` says which was sent.
 *
 * Absent when talking to a node older than the change that added it.
 */
export interface GameStateMeta {
    full?: boolean;
}

export type GameStateOutcome =
    /** Adopt this board. */
    | { action: 'replace'; state: GameState }
    /** Apply the payload to the board we hold as a delta. */
    | { action: 'patch'; delta: unknown }
    /** Nothing to do — an empty delta means the board did not change. */
    | { action: 'ignore' }
    /** We cannot use this; ask the node for a complete board. */
    | { action: 'resync' };

/**
 * Decide what to do with an incoming `gamestate` payload.
 *
 * The client used to work this out by looking at itself — "I am holding no
 * board, so this must be a complete one" — which is wrong exactly when the node
 * reset its baseline while this socket stayed up. A second client signed in as
 * the same user does that, and the mistake is not recoverable in place: handing
 * a whole game state to a delta patcher destroys fields silently, and in the web
 * client's jsondiffpatch it loops forever on the first string value it meets.
 *
 * So: believe the node when it says, and when it cannot (an older node), fall
 * back to the old guess, which is right for every case except the one above.
 */
export function resolveGameState(
    current: GameState | undefined,
    payload: unknown,
    meta?: GameStateMeta
): GameStateOutcome {
    if (payload === undefined || payload === null) {
        return { action: 'ignore' };
    }

    const isFullState = meta ? !!meta.full : !current;

    if (isFullState) {
        return { action: 'replace', state: payload as GameState };
    }

    if (!current) {
        // A delta with nothing to apply it to. Adopting it would render the
        // delta as though it were a board.
        return { action: 'resync' };
    }

    return { action: 'patch', delta: payload };
}
