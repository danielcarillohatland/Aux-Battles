# Native app builds

AUX Battles now has Capacitor 8 projects for iOS and Android. The host and
player clients are bundled into each app; room state, realtime sockets, music
search, and licensed playback continue to use the hosted Fastify backend.

## Before the first store build

1. Confirm that `com.auxbattles.game` is the permanent bundle/application ID.
   Change it before creating App Store Connect or Play Console records if your
   organization uses a different reverse-domain ID.
2. Deploy the backend over HTTPS and set its public origin in
   `apps/web/.env.mobile`. The current value is
   `https://aux-battles.fly.dev`; it must resolve and serve the AUX API before a
   device build can create or join rooms. The same origin also serves
   `/yt-relay.html`, the page that hosts the YouTube player for the native apps
   (D-031): iOS runs the bundle from `capacitor://localhost`, which YouTube will
   not accept as a player parent, so in-game video on iPhone depends on that
   deployed page being reachable.
3. Keep secrets on the server. `VITE_AUX_API_ORIGIN` and
   `VITE_AUX_PUBLIC_ORIGIN` are public build-time addresses, not secret values.
4. Manual song entry is the default store-safe path. For real songs in a
   commercial build, set `AUX_YOUTUBE_API_KEY` on the backend and complete
   YouTube's quota audit (`docs/youtube-music.md`). Deezer previews
   (`docs/deezer-music.md`) are off in production unless `AUX_DEEZER_PREVIEWS=1`
   is set on the backend, which needs a Deezer agreement for a commercial
   release. Configure the optional rights-cleared catalog in
   `docs/licensed-music.md` only for additional music.

The backend permits Capacitor's exact local origins by default. Set a
comma-separated `AUX_ALLOWED_ORIGINS` only when an additional separately-hosted
web client needs cross-origin API access.

## Build and run locally

Requirements:

- Node.js 22 or newer.
- iOS: macOS with full Xcode 26 or newer and an Apple Developer signing team.
- Android: Android Studio 2025.2.1 or newer and the Android SDK. Any JDK can
  launch Gradle: `android/gradle/gradle-daemon-jvm.properties` pins the build
  daemon to Eclipse Temurin 21, and Gradle downloads it on first use (through
  the Foojay resolver declared in `android/settings.gradle`). This is what keeps
  a machine whose default `java` is JDK 25 from failing with
  `Unsupported class file major version 69`; Gradle 8.14 cannot run on JDK 25.

Install and synchronize the bundled web app into both native projects:

```sh
npm ci
npm run mobile:sync
```

Open iOS in Xcode:

```sh
npm run mobile:ios
```

Select the `App` target, choose your signing team, confirm the bundle ID, and
run on a simulator or device. For distribution, choose **Product > Archive**,
then **Distribute App > App Store Connect**.

Open Android in Android Studio:

```sh
npm run mobile:android
```

Let Gradle finish syncing and run the `app` configuration on an emulator or
device. For Play distribution, choose **Build > Generate Signed App Bundle or
APK > Android App Bundle**. Protect and back up the release keystore; upload
the signed `.aab` through a Play Console app using Play App Signing.

Run `npm run mobile:sync` after every web-code or web-asset change. Native-only
changes made in Xcode or Android Studio are preserved by Capacitor sync.

## Release checklist

- Increment iOS `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` and Android
  `versionName` / `versionCode` for each release.
- Test room creation, QR joining, reconnects, both music paths, and a complete
  match on physical devices against the production backend.
- Supply a privacy-policy URL, support URL/email, screenshots, age rating,
  category, review instructions, and any demo access App Review needs.
- Keep license evidence for every bundled/streamed track and verify that no
  development credentials, debug routes, or private audio masters enter the
  submitted bundle.
- Use TestFlight and a Play internal-testing track before production review.

The generated store art comes from `assets/logo.png`; Capacitor-generated iOS
and Android icons and splash screens are already included in their native asset
catalogs.
