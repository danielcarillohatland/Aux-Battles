# Deezer song search and 30-second previews

AUX BATTLES can search Deezer's public catalog and let the host play the
30-second preview clip Deezer publishes for every track. No developer key,
account, or subscription is needed. This is the same approach music-guessing
web games use to get real, recognisable songs for free.

## What players and hosts get

- Players search the full mainstream catalog from their phones (`GET
  /api/v1/search`) and see a `30S PREVIEW · DEEZER` badge on each result.
- Submissions are canonicalised by Deezer track id on the server, like every
  other catalog: client-supplied metadata and URLs are discarded.
- At playback time the host presses **Play 30-second preview**. The host browser
  asks `GET /api/v1/rooms/:code/deezer/:id/preview` (host token required), gets
  a fresh clip URL, and plays it through the `<audio>` element. The excerpt
  window always starts at 0 because the clip *is* the highlight.
- An **Open in Deezer** link and a "30-second preview via Deezer" credit sit
  under every card, so Deezer is always named as the source.
- **Next song** is never gated on Deezer, so an outage cannot deadlock a round.

Deezer signs preview URLs for roughly 15 minutes. Search results and stored
submissions therefore never contain a clip URL; only the host's play request
resolves one, and nothing is proxied or stored by AUX BATTLES.

## Configuration

| Variable | Effect |
| --- | --- |
| `AUX_DEEZER_PREVIEWS` unset or `0` | Off (the default everywhere). YouTube (`docs/youtube-music.md`) is the product catalog. |
| `AUX_DEEZER_PREVIEWS=1` | On. Intended for offline-style playtests only. |

Deezer, Apple MusicKit, and the licensed manifest can run side by side; the
combined catalog merges results and keeps searching when one provider fails.

Deezer's public API allows about 50 requests per 5 seconds per IP. The server
caches search results for two minutes and track metadata for ten, and the
search route already limits each client to 60 requests per minute.

## Licensing position (read before a commercial release)

Deezer's [Terms of Use for Developers](https://developers.deezer.com/termsofuse),
section IV, state that use of the API "is strictly limited for a non-commercial
purpose and in a non-commercial environment", and that the developer must not
"perceive, receive, generate, benefit or create directly or indirectly, any
moneys, incomes, revenues" in connection with the service or its content. The
[developer FAQ](https://support.deezer.com/hc/en-gb/articles/360011538897-Deezer-FAQs-For-Developers)
adds that Deezer issues no certification for commercial use and that
whitelisting an application requires a commercial agreement reached through
their partner contact form. Full tracks are never available; the API exposes
only the 30-second extracts, and offline storage of audio is forbidden.

Consequences for AUX BATTLES:

- Local playtests, demos, and free builds can use Deezer previews as shipped.
- A paid or ad-supported release must either obtain a written agreement from
  Deezer (then set `AUX_DEEZER_PREVIEWS=1` in production), or leave the flag off
  and rely on [YouTube](youtube-music.md), manual entry,
  [Apple MusicKit](apple-music.md), or the
  [rights-cleared manifest](licensed-music.md).
- Do not swap in iTunes Search API previews as a workaround: Apple's terms and
  App Review guidance prohibit using Apple Music/iTunes previews for a game's
  entertainment value (recorded in D-021).
- Keep the Deezer credit and link visible wherever a preview is played; Deezer's
  trademark guidelines require its content to be identified as Deezer's.

This file records the product owner's understanding of publicly posted terms on
the date of D-023. It is not legal advice; confirm with counsel before charging
for a build that has Deezer enabled.

## Testing

`apps/server/tests/deezer.test.ts` covers search normalisation, id validation,
cache behaviour, error mapping, and the host routes with a mocked `fetch`.
`apps/web/tests/deezer-music.test.ts` and `playback-view.test.ts` cover the host
client and the playback card copy. The automated suite runs with Deezer off
(`NODE_ENV=test`) so it never touches the network; run the game locally to
exercise the live API.
