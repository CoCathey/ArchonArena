/**
 * ARCHON (N32): the Vault Tour field this site ships with.
 *
 * These are the deck ids an operator supplied as the tournament field. They are
 * kept in code rather than in a migration because hydrating a deck needs a
 * Master Vault fetch, which SQL cannot do: the sweep seeds any missing row from
 * this list and then fetches the cards a few at a time, the same pacing the
 * Gauntlet's pool uses.
 *
 * `placing` is 'unknown' for every one of them, and that is deliberate rather
 * than lazy. The list arrived as "the Vault Tour decks" without saying which
 * took first and which took second, and the difference between "won the event"
 * and "came second" is exactly the sort of claim that must not be invented to
 * fill a column. An admin sets it on the Vault Tour screen, where the label is
 * theirs to correct; until then the matrix says "unconfirmed" instead of a
 * placing nobody verified.
 *
 * Seeding is ON CONFLICT DO NOTHING, so an operator's edits - a corrected
 * placing, a real event name, a removal - are never overwritten by a later
 * sweep. Removing an entry here does not delete it from a running site either;
 * this is a starting field, not a manifest.
 */
const DEFAULT_FIELD = [
    'c0ef2bf4-ccfc-40b6-a0c7-5d1608fe84a3',
    '0d4425e3-6064-4dae-9e8d-37cb389c8490',
    '0b641813-763a-4030-82b1-399053c2be67',
    '3a725015-a24c-47ac-8ab2-5b4cb1c86bb6',
    '6b4372b8-b7e7-475f-9948-4872c4262ad1',
    '2706bda4-1f2d-4ffa-97d4-c5c5c65339af',
    'ca2d0d0a-5686-4580-ae0a-327f786fd691',
    '34014824-6921-4f0d-a07c-1c7351166f7d',
    'fd9454d8-8f2d-4f2e-b371-771d211bd0ac',
    '02a3c827-03ba-420f-92b0-9044e5ecd0d7',
    '3842c58f-68b2-4c75-81c2-06c08d74d64d',
    '158300ae-858c-41f2-addf-959d9a8589f5',
    '512329f4-13aa-4536-a69f-9b6e5cc5b7e4',
    '4d56a0ae-278d-49ee-96fc-5288d3026787',
    'b7d82416-b6eb-47c0-a393-7b97c7c134ba',
    '4a0dc759-77db-4fe6-a4d8-0a22ac20c0cb',
    '60d89ea0-adfc-43d6-ac2c-60ee9212691f',
    // Supplied twice in the same list; a field is a set, and the seed is keyed
    // on the uuid, so the second copy is simply the same deck.
    '613eb0fb-389c-462e-90c1-dc58a2f6b449',
    'ac1e21dc-8609-4194-b69d-5f56df4bd906',
    'e5ccb0f9-1445-432e-b199-a3223458b792',
    'fff0d7d4-4efd-4a71-91b3-5997e594a8ca',
    '45d14008-d6f4-4370-bb77-b7a982340f1a',
    '61f6b92f-dd58-4edf-8196-b59e7b75d0ba'
];

/** What the seeded rows say until an operator says otherwise. */
const DEFAULT_EVENT = 'Vault Tour';

module.exports = { DEFAULT_FIELD, DEFAULT_EVENT };
