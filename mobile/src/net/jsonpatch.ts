/**
 * A jsondiffpatch-compatible delta patcher.
 *
 * The game node diffs successive game states with jsondiffpatch@0.4.1
 * (default options + an objectHash) and sends the deltas over socket.io.
 * jsondiffpatch's own browser/UMD builds resolve their diff-match-patch
 * dependency through a dynamic require that Metro cannot bundle, so instead
 * of shipping the library we implement the (stable, documented) delta format
 * directly:
 *
 *   [newValue]              -> value added
 *   [oldValue, newValue]    -> value replaced
 *   [oldValue, 0, 0]        -> value deleted
 *   [dmpPatchText, 0, 2]    -> long string patched via diff-match-patch
 *   { key: <delta>, ... }   -> nested object diff
 *   { _t: 'a', ... }        -> array diff:
 *       '_<n>': [value, 0, 0]      item removed from original index n
 *       '_<n>': ['', <dest>, 3]    item moved from original index n to dest
 *       '<n>':  [value]            item inserted at final index n
 *       '<n>':  <delta>            item at final index n patched in place
 *
 * The unit tests in test/jsonpatch.test.ts verify this implementation against
 * the exact jsondiffpatch version the server uses.
 */
import DiffMatchPatch from 'diff-match-patch';

const ARRAY_MOVE = 3;
const TEXT_DIFF = 2;

let dmp: DiffMatchPatch | null = null;

function getDmp(): DiffMatchPatch {
    if (!dmp) {
        dmp = new DiffMatchPatch();
    }
    return dmp;
}

export function clone<T>(value: T): T {
    if (value === undefined || value === null) {
        return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

function isArrayDelta(delta: Record<string, unknown>): boolean {
    return delta._t === 'a';
}

function patchTextDelta(left: unknown, patchText: string): string {
    if (typeof left !== 'string') {
        throw new Error('jsonpatch: cannot apply text delta to non-string value');
    }
    const engine = getDmp();
    const patches = engine.patch_fromText(patchText);
    const [result] = engine.patch_apply(patches, left);
    return result;
}

function patchArray(left: unknown[], delta: Record<string, any>): unknown[] {
    const array = left;
    const toRemove: number[] = [];
    const toInsert: { index: number; value: unknown }[] = [];
    const toModify: { index: number; delta: unknown }[] = [];

    for (const key of Object.keys(delta)) {
        if (key === '_t') {
            continue;
        }
        if (key[0] === '_') {
            const entry = delta[key];
            if (Array.isArray(entry) && (entry[2] === 0 || entry[2] === ARRAY_MOVE)) {
                toRemove.push(parseInt(key.slice(1), 10));
            } else {
                throw new Error(`jsonpatch: invalid array removal entry at ${key}`);
            }
        } else if (Array.isArray(delta[key]) && delta[key].length === 1) {
            toInsert.push({ index: parseInt(key, 10), value: delta[key][0] });
        } else {
            toModify.push({ index: parseInt(key, 10), delta: delta[key] });
        }
    }

    // Remove in descending original-index order, capturing moved values.
    toRemove.sort((a, b) => a - b);
    for (let i = toRemove.length - 1; i >= 0; i--) {
        const index = toRemove[i];
        const removed = array.splice(index, 1)[0];
        const entry = delta[`_${index}`];
        if (entry[2] === ARRAY_MOVE) {
            toInsert.push({ index: entry[1], value: removed });
        }
    }

    // Insert in ascending final-index order.
    toInsert.sort((a, b) => a.index - b.index);
    for (const insertion of toInsert) {
        array.splice(insertion.index, 0, insertion.value);
    }

    // Patch nested changes against the final positions.
    for (const modification of toModify) {
        array[modification.index] = patchInPlace(array[modification.index], modification.delta);
    }

    return array;
}

function patchObject(left: Record<string, unknown>, delta: Record<string, any>): unknown {
    for (const key of Object.keys(delta)) {
        const entry = delta[key];
        if (Array.isArray(entry)) {
            if (entry.length === 1) {
                left[key] = entry[0];
            } else if (entry.length === 2) {
                left[key] = entry[1];
            } else if (entry.length === 3 && entry[2] === 0) {
                delete left[key];
            } else if (entry.length === 3 && entry[2] === TEXT_DIFF) {
                left[key] = patchTextDelta(left[key], entry[0]);
            } else {
                throw new Error(`jsonpatch: invalid object delta entry at ${key}`);
            }
        } else if (entry && typeof entry === 'object') {
            left[key] = patchInPlace(left[key], entry);
        }
    }
    return left;
}

function patchInPlace(left: unknown, delta: unknown): unknown {
    if (delta === undefined || delta === null) {
        return left;
    }

    if (Array.isArray(delta)) {
        if (delta.length === 1) {
            return delta[0];
        }
        if (delta.length === 2) {
            return delta[1];
        }
        if (delta.length === 3 && delta[2] === 0) {
            return undefined;
        }
        if (delta.length === 3 && delta[2] === TEXT_DIFF) {
            return patchTextDelta(left, delta[0]);
        }
        throw new Error('jsonpatch: invalid root delta');
    }

    if (typeof delta === 'object') {
        const record = delta as Record<string, any>;
        if (isArrayDelta(record)) {
            if (!Array.isArray(left)) {
                throw new Error('jsonpatch: array delta applied to non-array');
            }
            return patchArray(left, record);
        }
        if (left === null || typeof left !== 'object') {
            throw new Error('jsonpatch: object delta applied to non-object');
        }
        return patchObject(left as Record<string, unknown>, record);
    }

    return left;
}

/**
 * Apply a jsondiffpatch delta to a value. The input is never mutated; a
 * patched deep copy is returned. Passing an undefined/null delta returns the
 * original value unchanged.
 */
export function patch<T = unknown>(left: T, delta: unknown): T {
    if (delta === undefined || delta === null) {
        return left;
    }
    return patchInPlace(clone(left), clone(delta)) as T;
}
