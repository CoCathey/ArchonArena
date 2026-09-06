# Gameplay test baseline

Every change — and every upstream sync (see UPSTREAM.md) — must keep the card/engine
suite at or above this baseline. Update this file whenever the baseline legitimately
moves (new cards, new tests).

| Date       | Commit basis                                 | Test files             | Tests passed | Failed | Skipped |
| ---------- | -------------------------------------------- | ---------------------- | ------------ | ------ | ------- |
| 2026-07-21 | keyteki `296c2742` import + rating engine    | 2671 passed, 2 skipped | 38,221       | 0      | 65      |
| 2026-07-21 | + DoK SAS + Keybringer SSO services          | 2673 passed, 2 skipped | 38,253       | 0      | 65      |
| 2026-08-17 | + replay misplay review (F3)                 | 2785 passed, 3 skipped | 40,144       | 0      | 66      |
| 2026-08-17 | + misplay review justification filters       | 2785 passed, 3 skipped | 40,157       | 0      | 66      |
| 2026-08-17 | + card knowledge, archives, answer-held      | 2786 passed, 3 skipped | 40,178       | 0      | 66      |
| 2026-08-17 | merged with main (Proving Grounds, ARI)      | 2791 passed, 3 skipped | 40,245       | 0      | 66      |
| 2026-08-18 | + forge denial, calibration, habits          | 2792 passed, 3 skipped | 40,253       | 0      | 66      |
| 2026-08-18 | merged with main (challenge bot, priors)     | 2833 passed, 3 skipped | 40,852       | 0      | 66      |
| 2026-08-27 | + mute-spectators click-target regression    | 2856 passed, 3 skipped | 41,091       | 0      | 66      |
| 2026-08-28 | + admin node Restart no longer shells to pm2 | 2858 passed, 3 skipped | 41,095       | 0      | 66      |
| 2026-09-02 | + self-serve iOS TestFlight request queue    | 2859 passed, 3 skipped | 41,100       | 0      | 66      |
| 2026-09-02 | + fix ReDoS in the TestFlight email check    | 2859 passed, 3 skipped | 41,101       | 0      | 66      |

Command: `npx vitest run` (~2.5 min). The skips are inherited from upstream.
