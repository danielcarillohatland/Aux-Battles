# Optional Apple Music catalog mode

AUX BATTLES works without Apple Music configuration: players can enter any song
title and artist, and the host opens it in an external music service. MusicKit
is an optional enhancement that adds Apple's official catalog search and
in-app playback. Audio is fetched and rendered by Apple; this server never
downloads, proxies, caches, edits, or redistributes Apple Music audio.

## Setup

1. In the Apple Developer portal, enable MusicKit for a Media ID and create a
   Media Services private key.
2. Generate a signed MusicKit developer token following Apple's documentation.
3. Configure the token and the two-letter storefront used for catalog search:

```sh
AUX_APPLE_MUSIC_DEVELOPER_TOKEN=your-signed-jwt
AUX_APPLE_MUSIC_STOREFRONT=no
```

The developer token is delivered only to the authenticated room host with a
`no-store` response. It does not contain the Media Services private key. Keep
the private key out of this repository and out of the deployed web bundle.

## Runtime behavior

- With no token, the lobby shows **Any song · no setup** and the manual flow is
  fully playable.
- Players search canonical Apple Music song metadata through the server.
- Submitted metadata is discarded and re-resolved by song id.
- The host presses **Play with Apple Music**, signs in, and starts playback.
- Play, pause, and next controls remain under the host's direct control.
- **Next song** is always available, including when authorization or playback
  fails, so a provider outage cannot deadlock a game.
- An **Open in Apple Music** link provides a manual recovery path.

An active Apple Music subscription is required for full playback. Availability
varies by storefront. Do not use iTunes/Apple Music preview clips as game audio.
MusicKit is not a substitute for separate synchronization/adaptation rights if
the product later times, edits, records, shares, or otherwise deeply integrates
a particular recording. Re-review Apple's current agreement and App Review
Guidelines before release.
