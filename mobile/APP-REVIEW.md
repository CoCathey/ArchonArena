# Archon+ on iOS and Android: what review will ask about

Archon+ is a membership sold on the website through Patreon. The apps let a
player **use** a membership they already bought; they do not sell one. This
document is the reasoning behind that, and the notes to put in front of a
reviewer.

Everything the apps are allowed to say about paying is decided in one file —
`src/membership/storePolicy.ts` — and asserted in `test/membership.test.ts`. If
those tests fail, the iOS build is no longer submittable.

---

## The short version

|                                  | iOS   | Android |
| -------------------------------- | ----- | ------- |
| Describes what membership includes | yes   | yes     |
| Shows the tier the account is on   | yes   | yes     |
| Connect an existing Patreon account | yes   | yes     |
| Shows prices                       | **no** | yes     |
| Links to Patreon checkout          | **no** | yes     |

---

## The money is not in the build, not merely hidden

The screens guard every money surface on `canShowPurchaseLinks()`, but a guard
is something a future edit has to remember. So the client also strips
`priceUsd` and `checkoutUrl` out of the tier catalogue before any screen sees
it (`src/membership/catalogPolicy.ts`), and both fields are optional in the
type — a screen that forgets the guard cannot compile a price block, and a `$`
cannot be rendered from a number that is not there.

`test/membership.test.ts` asserts this against a real catalogue payload: no
price, no checkout URL, no `patreon.com` and no `$` anywhere in the JSON an iOS
build receives — while the tier names, taglines and benefit copy all survive,
which is what 3.1.3(b) permits.

## Why iOS has no prices and no purchase links

**Guideline 3.1.1 (In-App Purchase)** forbids "buttons, external links, or other
calls to action that direct customers to purchasing mechanisms other than
in-app purchase". Patreon is not in-app purchase, so a "Choose Archon — $10/mo"
button, or a link to `patreon.com/checkout/...`, is exactly the thing that gets
an app rejected. A price is treated as a call to action even with no link
attached to it, which is why iOS omits those too.

**Guideline 3.1.3(b) (Multiplatform services)** is what the app relies on
instead: an app may let a user access content or subscriptions they acquired
elsewhere. Archon Arena is a website first; memberships are bought there, and
the app unlocks what the account already has. That is the permitted shape, and
it is the shape the app takes.

So on iOS the Archon+ screen:

- lists what each tier includes, in words, with no prices;
- shows the tier the signed-in account is already on;
- offers **Connect Patreon**, and nothing else;
- links to no checkout, no campaign page, and no membership page.

## Why "Connect Patreon" is not a purchase

It is an OAuth **sign-in**. The player already has (or does not have) a Patreon
membership; connecting proves which. No money moves, no product is selected, and
the flow cannot start a subscription — Patreon's consent screen only grants
read access to identity and membership status.

The flow uses `WebBrowser.openAuthSessionAsync`, which is
`ASWebAuthenticationSession` on iOS. This matters for review as well as for
security:

- The app **never sees the player's Patreon password**. Collecting a third
  party's credentials in your own UI is a rejection under Guideline 4.0 and
  5.1.1, and an embedded WebView would be doing exactly that.
- The player sees the genuine `patreon.com` address bar and certificate.

## Free functionality is not gated

Nothing about playing is behind the membership. Unlimited games, deck import,
matchmaking, leaderboards, tournaments and spectating are free on every tier,
and no membership perk affects Amber, matchmaking, tournament eligibility or any
other competitive outcome. Membership unlocks analytics about the player's own
games.

This is worth stating in the review notes, because "premium tiers" in a game
usually implies pay-to-win and it is not the case here.

## Locked panels

A player without a membership sees the premium panels described rather than
hidden, with a single button that opens the Archon+ screen. On iOS that screen
does not sell anything, so the chain never terminates in a purchase call to
action.

---

## Review notes to paste into App Store Connect

> Archon Arena is a free, fan-run platform for the KeyForge card game. All
> gameplay is free and unlimited; there are no in-app purchases and nothing in
> the app can be bought.
>
> "Archon+" is an optional membership that supporters buy on our website
> through Patreon. The app does not sell it and contains no prices, purchase
> buttons, or links to any purchasing mechanism. Under Guideline 3.1.3(b), the
> app lets a member sign in to their existing Patreon account so the analytics
> features they already pay for unlock on their phone.
>
> "Connect Patreon" opens ASWebAuthenticationSession for a standard OAuth
> sign-in. The app never handles Patreon credentials.
>
> Membership affects only statistics and analysis of the player's own games. It
> does not affect gameplay, matchmaking, or competitive outcomes.

**Demo account:** provide a test account with a complimentary Archon tier so a
reviewer can see the unlocked panels without connecting anything. Grant it from
the admin membership tools rather than through Patreon.

---

## Android

Google Play's rules on external links for a multiplatform service are looser
than Apple's, so the Android build shows the full tier list with prices and
Patreon links. If Play review ever objects, set `android: false` in
`PURCHASE_LINKS_BY_PLATFORM` (`src/membership/storePolicy.ts`) and rebuild —
every screen already handles that case, because iOS forced them to.

## Known blocker, unrelated to membership: account deletion

**Guideline 5.1.1(v)** requires that an app which lets people create an account
also lets them delete it, initiated from inside the app. This app has a register
screen, and there is no account deletion anywhere — not in the app, not on the
website, and not in the API. That is one of the most common automatic
rejections, and it will bite regardless of anything on this page.

It is a real piece of work rather than a screen: an account owns decks, games,
ratings, tournament entries and a membership, and some of that data is shared
with other players (a finished game belongs to both of them). It needs a
decision about what is erased versus anonymised before it is written, so it is
called out here rather than guessed at.

## Still open, and not fixable in code

**Intellectual property (5.2.1 / 5.2.5) — the most likely rejection.** Card
faces stream from `archonarena.com/img/cards/`, and `server/scripts/fetchdata/
KeyforgeImageSource.js` shows those are downloaded copies of Master Vault art
re-served from our host. The card back, house sigils, key and Æmber icons are
bundled in the IPA. A reviewer reaches card art from the Decks tab without
playing a game, and meets the trademark in the login tagline before that. The
attribution now appears pre-auth on the login screen, which is the most that
code can do — 5.2.1 asks for a licence, not a disclaimer. Expect the App Store
name, subtitle and keywords to need scrubbing of "KeyForge" too.

**A solo reviewer cannot reach a game.** There is no AI, practice or solo mode,
so the core feature needs a second human. Supply two demo accounts and say so in
the review notes, or accept that this is what the first rejection will be about.

**iPad.** `app.json` declares `supportsTablet: true` and the layout is a
portrait-locked single column. Either fix the layout or set it false.

**Age rating.** The questionnaire has to reflect unfiltered user-to-user chat,
now that a content filter exists but is a denylist rather than a classifier.

## If Apple objects anyway

Reviewers differ, and the most common objection to this shape is to the
*wording* rather than to the mechanism. In order of least to most disruptive:

1. Soften the copy on the Archon+ screen — remove any sentence that could be
   read as directing the player off-platform.
2. Remove the Archon+ screen from navigation on iOS entirely and reach account
   linking only from Profile. `storePolicy.ts` is where to branch.
3. Add In-App Purchase for the tiers as an alternative payment path on iOS.
   This is a real project: it needs StoreKit, receipt validation, and a way to
   reconcile an IAP subscription with a Patreon one on the same account.

Do not add an external link back "just for iOS" without re-reading 3.1.1 — that
is the specific change that turns an approved build into a rejected one.
