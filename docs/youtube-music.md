# YouTube song search and video playback

This is the recommended music path for a commercial release. Players search
YouTube's music catalog from their phones and the host plays the official video
in YouTube's own embedded player on the host screen. It is free, and YouTube's
developer terms contain no games prohibition and no non-commercial clause, which
is what rules out every other free catalog (see `docs/DECISIONS.md` D-023 and
D-024).

## How it works

- The server holds a YouTube Data API v3 key (`AUX_YOUTUBE_API_KEY`) and proxies
  player search through `GET /api/v1/search`. The key never reaches a client.
- One search calls `search.list` (music category, embeddable, syndicated videos)
  and then a single `videos.list` for the batch, which supplies duration,
  embeddability, privacy status, and thumbnails. Shorts under 30 seconds, mixes
  and albums over 12 minutes, live streams, and non-embeddable videos are
  dropped. Titles are split into artist and title using the near-universal
  "Artist - Title (Official Video)" convention; the channel name is the fallback
  artist.
- A search hit *is* the video: track ids are `youtube:<videoId>`, so submission
  canonicalisation costs one unit and playback costs nothing.
- On the host, the playback card autoplays the official IFrame player, seeks to
  the excerpt start chosen by the server, and pauses the video when the
  highlight window ends. The player lives in `/yt-relay.html`, a static page on
  the game's own http(s) origin, so YouTube always sees a real hostname as the
  parent (it refuses IP-address and `capacitor://` parents). Play/Pause and
  **Next song** stay under host control, and Next is never gated on YouTube.

## Configuration

| Variable | Effect |
| --- | --- |
| `AUX_YOUTUBE_API_KEY` | Enables the provider. Create it in Google Cloud Console with the YouTube Data API v3 enabled, restricted to that API. |
| `AUX_YOUTUBE_REGION` | Optional ISO 3166-1 alpha-2 code (for example `NO`) used to rank and filter results for the room's country. |

Without a YouTube key the game has no search catalog and players enter songs
manually; Deezer is never on unless `AUX_DEEZER_PREVIEWS=1` is set explicitly.

## Quota

Every Google Cloud project starts with 10,000 units per day. `search.list` costs
100 units and `videos.list` 1, so the default allowance is roughly 99 distinct
searches per day across all rooms. The server caches search results for six
hours and video details for a day, coalesces identical concurrent queries, and
the search route limits each client to 60 requests per minute. That is enough
for development and small playtests, not for a public launch.

Before launch, submit the free **YouTube API Services - Audit and Quota
Extension Form** from the Google Cloud console. The audit checks compliance with
the Developer Policies below and normally grants a much larger allowance. When
quota is exhausted, the provider reports `CATALOG_DOWN`; the combined catalog
keeps serving any other configured provider and players can still enter songs
manually.

## Policy requirements built into the UI

From YouTube's [Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
and [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality):

- The player must be at least 200×200 pixels, fully visible, with no overlays
  or frames in front of it, and it must not be modified beyond the documented
  API. The `.youtube-player` container enforces the minimum size and nothing is
  layered on top of it.
- Audio must not be separated from video or played from a background player
  (III.I.7 to III.I.9). The host card shows the video; there is no audio-only
  mode for YouTube tracks.
- Autoplay may only begin once more than half the player is visible. Playback
  starts from the host's click, after the container is on screen.
- YouTube must be identified as the source (III.F.2.a). Search results carry a
  `YOUTUBE` badge, the playback card says "Official video · YouTube", credits
  the channel, and links to the video on YouTube.
- Do not charge users to watch content in the embedded player (III.F.3.a). Selling
  the game is fine; putting the video itself behind a paywall is not.
- Advertising around API data is only allowed when the page offers enough
  independent value (III.G.1.d). Do not place ads on the playback screen.
- API data may be cached for at most 30 days (III.E.4.d). The server caches for
  hours, not days.

Review the YouTube brand guidelines for the exact wordmark treatment before a
store release, and complete the quota audit while the app already complies.

## Testing

`apps/server/tests/youtube.test.ts` covers search filtering, quota and outage
mapping, caching, id validation, title splitting, and the host status route with
a mocked `fetch`. `apps/web/tests/youtube-player.test.ts` and
`playback-view.test.ts` cover the host helpers and copy. The IFrame player
itself can only be exercised in a browser: run the game locally with a key, pick
a song, and press **Play on YouTube**.
