# Rights-cleared music mode

This optional path adds commissioned or purchased recordings to AUX Originals.
It is not a blanket legal opinion: the publisher must obtain and retain the
rights for every recording and territory in which the game ships.

## Why this exists

- Apple's [App Review Guidelines §5.2](https://developer.apple.com/app-store/review/guidelines/)
  require permission for third-party content and authorization for streamed
  services. They specifically say Apple Music/iTunes previews cannot be used for
  entertainment value as a game soundtrack.
- Google Play's [Intellectual Property policy](https://support.google.com/googleplay/android-developer/answer/9888072)
  requires original content or documented permission and may ask for evidence.
- Jamendo says its upgraded licenses can cover [international mobile apps and
  video games](https://support-licensing.jamendo.com/individual-licenses). Confirm
  the exact license SKU and current terms for each purchase before relying on it.

The implemented expansion path therefore uses files controlled by the publisher,
with a manifest that attests to commercial game/app-store rights and points to a
license document kept beside every track.

## Required rights

For every track, obtain written rights that cover at least:

1. The sound recording (master) and underlying composition.
2. Synchronization/interactive use in a video game or mobile application.
3. Commercial use and digital distribution through every intended app store.
4. Every country/territory where the game is available.
5. Excerpting, seeking, cutting, or looping if AUX BATTLES uses highlights.
6. Marketing captures/trailers separately, if store screenshots or videos contain
   protected artwork or audio.

Keep invoices, license certificates, the terms in force on the purchase date,
and any direct artist/publisher agreements. Store reviewers may request them.

## Catalog setup

Keep purchased audio and evidence outside source control, preferably on encrypted
persistent deployment storage:

```text
/data/licensed-music/
  manifest.json
  audio/
    party-one.mp3
  licenses/
    party-one-license.pdf
```

Start from [licensed-music.manifest.example.json](licensed-music.manifest.example.json),
then configure:

```sh
AUX_LICENSED_MUSIC_MANIFEST=/data/licensed-music/manifest.json
AUX_LICENSED_MUSIC_ROOT=/data/licensed-music
```

Every manifest track also needs a concise `description` of its sound so the
judge can evaluate unfamiliar music without inventing details. The server
refuses to start if:

- a track, evidence file, required field, or required grant is missing;
- an evidence path or audio path escapes the configured root;
- a license expiry is invalid or has passed;
- an audio format is unsupported; or
- ids are duplicated or unsafe.

This is intentionally fail-closed. The booleans are publisher attestations; the
server cannot determine whether a PDF actually grants the claimed rights.

## Runtime behavior

- Search combines the always-present AUX Originals with this licensed catalog.
- A licensed id plays its timed excerpt inside the same approved in-app catalog
  mode used by project-owned originals.
- Audio is not placed in the public web bundle. The host fetches it through an
  authenticated, `no-store` endpoint and uses a short-lived in-memory object URL.
- Players cannot supply playback URLs or metadata: submission routes replace
  them only after resolving the id against an approved catalog.
- Timer-expiry “chicken” picks come from the combined approved catalog.

## Store submission checklist

- Make the publisher/licensee in the manifest match the legal entity submitting
  the game.
- Keep a rights spreadsheet mapping manifest ids to license evidence and store
  territories.
- Provide authorization documents to App Review or Google Play if requested.
- Do not market this mode as giving access to a service's entire catalog; it
  exposes only the specific tracks you licensed.
- Re-review service and store terms before every major release.
