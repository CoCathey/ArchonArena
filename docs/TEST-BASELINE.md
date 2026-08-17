# Gameplay test baseline

Every change — and every upstream sync (see UPSTREAM.md) — must keep the card/engine
suite at or above this baseline. Update this file whenever the baseline legitimately
moves (new cards, new tests).

| Date       | Commit basis                              | Test files             | Tests passed | Failed | Skipped |
| ---------- | ----------------------------------------- | ---------------------- | ------------ | ------ | ------- |
| 2026-07-21 | keyteki `296c2742` import + rating engine | 2671 passed, 2 skipped | 38,221       | 0      | 65      |
| 2026-07-21 | + DoK SAS + Keybringer SSO services       | 2673 passed, 2 skipped | 38,253       | 0      | 65      |
| 2026-08-17 | + replay misplay review (F3)              | 2785 passed, 3 skipped | 40,144       | 0      | 66      |
| 2026-08-17 | + misplay review justification filters    | 2785 passed, 3 skipped | 40,157       | 0      | 66      |
| 2026-08-17 | + card knowledge, archives, answer-held   | 2786 passed, 3 skipped | 40,178       | 0      | 66      |

Command: `npx vitest run` (~2.5 min). The skips are inherited from upstream.
