# Shipping Archon Arena Mobile to TestFlight

This walks you from a clean machine to the app installed on your iPhone via
TestFlight. **You do not need a Mac** — Expo Application Services (EAS) builds
and uploads from the cloud. You can do all of this from macOS, Windows, or Linux.

---

## 0. What you need first

**Accounts**

- **Expo account** — free, sign up at https://expo.dev/signup
- **Apple Developer Program membership** — **paid, $99/year**, required for
  TestFlight. Enroll at https://developer.apple.com/programs/enroll/. Allow a
  few hours to a day for Apple to approve enrollment; nothing below works until
  it does.

**Tools on your machine**

- **Node.js 20 or 22 (LTS)** — https://nodejs.org
- **Git** — https://git-scm.com
- **EAS CLI** — install after Node:
  ```bash
  npm install -g eas-cli
  ```
- An **iPhone** with the **TestFlight** app (from the App Store) for testing.

---

## 1. Get the code

The app lives in the `mobile/` folder on the `claude/expo-keyforge-iphone-app-ysra0x`
branch.

```bash
git clone https://github.com/CoCathey/ArchonArena.git
cd ArchonArena
git checkout claude/expo-keyforge-iphone-app-ysra0x
cd mobile
npm install
```

> Run every `eas`/`expo` command below from inside this `mobile/` folder.

---

## 2. ⚠️ Point the app at a reachable server (important)

The app is a **client**. On a real iPhone out in the world it cannot see a
server running on your laptop (`localhost`), and iOS blocks plain-`http://`
connections. Testers need a **public, HTTPS** Archon Arena backend.

You have two options:

- **A — Set a default server.** If the backend is deployed (e.g. at
  `https://archonarena.com`), open `src/stores/settingsStore.ts` and make sure
  `DEFAULT_SERVER_URL` points at it. It currently is:
  ```ts
  export const DEFAULT_SERVER_URL = 'https://archonarena.com';
  ```
- **B — Let testers set it.** Every tester can tap **Server settings** on the
  login screen and enter a URL — but it must be **HTTPS** and reachable from the
  public internet.

If you don't have the backend deployed yet, it lives in the repo root of this
project (Docker + deploy configs, see the top-level `docs/DEPLOYMENT.md` on the
platform branch). The app can't be meaningfully tested until a server is up.

---

## 3. Link the project to your Expo account

```bash
eas login          # sign in with your Expo account
eas init           # creates the EAS project, writes projectId into app.json
```

`eas init` adds an `owner` and `extra.eas.projectId` to `app.json`. Commit that
change so future builds stay linked:

```bash
git add app.json && git commit -m "Link EAS project"
```

The `eas.json` build config is already in the repo, so you can skip
`eas build:configure`.

> **Bundle identifier:** the app uses `com.archonarena.app`. If someone else has
> already registered that on the App Store, edit `ios.bundleIdentifier` in
> `app.json` to something unique (e.g. `com.<you>.archonarena`) before building.

---

## 4. Build the iOS app in the cloud

```bash
eas build --platform ios --profile production
```

The first time, EAS handles Apple credentials for you:

- When prompted **"Do you want to log in to your Apple account?"**, say **yes**
  and sign in with your **Apple Developer** account.
- Let EAS **create the Distribution Certificate and Provisioning Profile**
  automatically (just press Enter on the defaults).

EAS then builds on a cloud macOS machine (~10–20 min) and gives you a build URL.
No `.ipa` download needed — the next step pulls it straight from EAS.

---

## 5. Submit the build to TestFlight

```bash
eas submit --platform ios --profile production --latest
```

- `--latest` grabs the build you just made.
- Sign in with your Apple account when prompted.
- If no App Store Connect app record exists yet, **EAS offers to create one** —
  accept it. (App name must be unique on the App Store; if "Archon Arena" is
  taken, pick another display name when asked — it doesn't change the app's
  on-device name.)

EAS uploads the build to App Store Connect. Apple then "processes" it for
~5–15 minutes.

---

## 6. Turn on TestFlight and install

1. Go to https://appstoreconnect.apple.com → **My Apps** → **Archon Arena** →
   **TestFlight** tab.
2. Wait for the build to move from **Processing** to ready.
   - Export-compliance is already answered in the app (`ITSAppUsesNonExemptEncryption:
     false`), so it won't ask.
3. **Internal testing** (fastest, no Apple review, up to 100 people on your
   team): add yourself under **Internal Testing**, using the Apple ID email
   tied to your developer account.
   - **External testing** (up to 10,000 testers by email/link) requires a quick
     **Beta App Review** first.
4. On your iPhone: install **TestFlight** from the App Store, open the invite
   (email or link), and install **Archon Arena**.

Done — you're playing KeyForge on your phone. 🎉

---

## 7. Shipping a new build later

Each TestFlight upload needs a higher build number. `eas.json` is set to
`autoIncrement`, so EAS bumps it for you — just rebuild and resubmit:

```bash
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

Bump the user-facing version (`version` in `app.json`, e.g. `0.1.0` → `0.2.0`)
when you want a new marketing version.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Testers see "Could not reach the server" | The server URL isn't public/HTTPS. See **step 2**. |
| `eas build` fails on credentials | Re-run `eas credentials -p ios` and let EAS regenerate the cert/profile. |
| "Bundle ID already exists / not available" | Change `ios.bundleIdentifier` in `app.json` and rebuild. |
| Build uploaded but not in TestFlight | Give it 5–15 min to process; refresh the TestFlight tab. |
| Apple enrollment not finished | TestFlight needs the paid Developer Program; wait for approval. |

## Sanity checks before building (optional)

```bash
npm run typecheck   # strict TypeScript, should be clean
npm test            # jsonpatch unit + fuzz tests
npx expo-doctor     # flags common config problems
```
