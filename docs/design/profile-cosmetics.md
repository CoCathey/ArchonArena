# Profile cosmetics

## Goal

Give `profile_cosmetics` (Supporter, $5) and `enhanced_cosmetics` (Vault
Master, $20) something to actually be. Both capabilities existed in the tier
list and both were flagged `planned`, because the only customisation on the
site was the game board background - which is free. Supporter's pricing card
promised "customise how your profile looks" and nothing on the site did.

The rule from N12 applies to all of it: **cosmetic and convenience only**.
Nothing here touches Amber, matchmaking, tournament eligibility or any other
competitive outcome.

## What a member gets

| Slot           | Supporter                               | Vault Master                   |
| -------------- | --------------------------------------- | ------------------------------ |
| Accent colour  | 15 house palettes                       | any colour, via a picker       |
| Profile banner | 15 house banners                        | 3 set/card illustrations       |
| Avatar frame   | brass, aember, shadow, verdant, crimson | prismatic (follows the accent) |
| Title          | 10 curated titles                       | 2 more                         |
| Name effect    | glow                                    | gradient, shimmer              |
| Bio length     | 1000 characters (280 free)              | 1000                           |

Where they appear: the accent, banner, frame and title on `/players/:username`;
the frame and name effect anywhere a name or avatar is rendered - lobby chat,
game seats, the game list, the nav.

## Shape

```
server/services/membership/cosmetics.js      the catalogue + all the rules
server/services/community/ProfileCosmeticsService.js   read/write the row
server/db/schema/migrations/67 - ProfileCosmetics.sql  one row per user
client/cosmetics.js                          id -> pixels, and nothing else
client/Components/Profile/ProfileCosmetics.jsx  the editor, with live preview
```

Three properties are worth keeping if this is ever extended.

**The server owns ids; the client owns pixels.** A stored value is a member of
a closed set defined in `cosmetics.js`. The client maps that id to a colour, an
image or a class, and an id it does not recognise draws the default. Nothing a
player submits is ever rendered as style, so a cosmetic cannot become an
injection surface. The one exception is a custom accent, which _is_ data: it is
validated as `#rrggbb`, lightened if it is too dark to read (`normalizeAccentHex`),
and passed to CSS as a custom property rather than interpolated into a class.

**Lapsing hides, it never deletes.** `resolveCosmetics(stored, capabilities)`
filters a selection against what the account may use _right now_, and every
read path goes through it - the public profile, the badge batch, the lobby
summary. A lapsed pledge stops rendering on the same day the badge does, and
resubscribing restores exactly what they had. There is no sweep job and no
cleanup, so there is nothing to get wrong.

**Rendering falls back; saving refuses.** `resolveCosmetics` silently drops a
locked slot, because a profile has to render. `sanitizeCosmetics` rejects the
whole save and names the offending slot, because a settings page that stores
something other than what you sent it will lie to you afterwards.

## Adding a cosmetic

1. Add the option to the right list in `server/services/membership/cosmetics.js`,
   with `capability: SUPPORTER` or `ENHANCED` (or `null` for free).
2. Give the client something to draw:
    - **accent** - the hex is in the catalogue entry; nothing else to do.
    - **banner** - drop the art in `client/assets/img/bgs/` and run
      `node scripts/generate-profile-banners.js`. The client globs the output
      directory, so no import is needed.
    - **frame / name effect** - add the class to the map in `client/cosmetics.js`
      and the CSS to the cosmetics block in `client/styles/tailwind.css`.
    - **title** - nothing; it is words.
3. That is all. The editor, the API, validation and the public profile are all
   driven by the catalogue.

Moving a cosmetic between tiers is one edit to its `capability`. Every upgrade
prompt on the editor names its tier by looking it up in the membership
catalogue, so the copy follows automatically.

## Banner art

The board backgrounds are square-ish and up to 4.1MB (`philophosaurus.png`); a
banner is a 1200x300 strip behind a name. `scripts/generate-profile-banners.js`
crops and re-encodes them into `client/assets/img/banners/`, where the whole
set of eighteen is under half a megabyte and no single banner exceeds 47KB.
Rerun it after adding art.

## Notes

-   **Titles are curated, not free text.** A bio is already a moderated
    free-text field with a report button; a second one would double that
    surface for a line of flavour, and a title that has to be reviewed cannot
    appear immediately. A closed list needs no moderation, so a title is live
    the moment it is chosen.
-   **Cosmetics resolve _with_ the admin override, unlike the badge.**
    `publicBadge` strips it deliberately - calling every administrator a Vault
    Master patron is a claim about money that is not true. An accent colour
    makes no such claim, and an admin who cannot see the frame they just picked
    would file a bug.
-   **Vault Master became purchasable.** `isTierPurchasable` derives whether a
    tier may be sold from whether it delivers anything, today, that the tier
    below it does not. Vault Master had failed that check since it was written:
    all five of its capabilities were unbuilt. `enhanced_cosmetics` is the first
    of them to ship, so the tier is now on sale - automatically, with no flag to
    flip.
-   **A deployment that has not migrated still works.** Every reader tolerates
    `ProfileCosmetics` being absent; `BadgeService` retries without the join and
    stops asking, because losing every badge on the site over a decoration table
    would be a far worse failure than losing the decoration.
