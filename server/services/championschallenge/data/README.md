# Challenge bot data files

## `cardPriors.json`

The card-text priors the learning bot starts unseen cards from — see
`../cardPriors.js` for how they are read and `labPolicy.shrink` for how the
evidence takes over.

Generated, not written by hand:

```
ANTHROPIC_API_KEY=... npm run card-priors
```

(`npm run card-priors -- --dry-run` prints what would be submitted and a rough
cost without calling anything; `--limit 40` scores a small sample first.)

The job reads every card in `master-vault-data/packs`, has a language model
score each card's competitive impact 0–10 from its printed text (one Message
Batch, roughly a few dollars once), and merges the scores here. It is
resumable — already-scored cards are skipped — so re-running it after a new
set releases only pays for the new cards.

Commit the generated file: it ships with the code so that servers need no API
key at runtime. A server without the file simply plays without priors.

## `cardTraits.json`

AERC-style axis scores per card (expected amber, amber control, creature
control, artifact control, efficiency, disruption — the taxonomy is Decks of
KeyForge's shared vocabulary; the scores are this platform's own), plus
synergy tags: the mechanics each card `provides` and `wants`. Feeds the
graded `card:ax:*` features and the combo signals `card:syn:board` /
`card:syn:hand` via `../cardTraits.js`.

```
ANTHROPIC_API_KEY=... npm run card-traits
```

Same shape as the priors job: one Message Batch (~$3–4 once), resumable,
`--dry-run` and `--limit` for previews. Commit the result; a server without
the file simply emits no axis features.
