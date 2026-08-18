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
