# Legacy AUX Originals

AUX Originals is retained for old room checkpoints and automated fixtures, but
it is no longer enabled in product builds. It uses no streaming service,
embedded third-party recording, downloaded preview, or audio sample. Each
instrumental is defined as an original data recipe in
`packages/shared/src/original-catalog.ts` and synthesized at playback time by
the Web Audio implementation in `apps/web/src/host/original-music.ts`.

## Rights boundary

This design removes the usual master-recording and streaming-service license
dependency. It does not replace legal review: the publisher must still own the
project output, avoid deliberately reproducing another composition, and retain
the source history showing how each recipe was created. [Apple App Review
Guideline 5.2](https://developer.apple.com/app-store/review/guidelines/) requires
the app to contain only content the publisher created or has permission to use.

No recipe in Volume One is described as a cover, sound-alike, or adaptation.
The synthesizer creates its own oscillators, envelopes, filtered noise, drums,
and note scheduling. The repository and built native bundles contain no MP3,
WAV, AAC, M4A, OGG, or FLAC files for AUX Originals.

## Approved-catalog flow

1. When the legacy `AUX_ENABLE_ORIGINALS=1` flag is set, player search can return
   canonical AUX Originals alongside other configured catalogs.
2. A submission sends a track id, but the server discards all client-supplied
   title, artist, description, credit, source, and playback URL values.
3. The server resolves the id against the approved catalog. Unknown ids are
   rejected before persistence, playback, or judge review.
4. During playback, original ids select their bundled synth recipe. Licensed
   additions use an authenticated, non-cacheable audio endpoint.
5. Judge review receives the canonical title, artist, and sonic profile. This
   lets the judge evaluate unfamiliar original instrumentals without inventing
   lyrics or pretending to recognize a recording.

## Adding an original

Add a unique `original:*` definition with title, description, search tags, and a
new synth recipe. Do not copy a recognizable melody, arrangement, recording, or
sample. Add catalog, playback-resolution, and judge-prompt tests, then retain a
dated authorship note with the release records.

`Midnight Pancakes` is the first explicit new-song example. Its canonical sonic
profile reaches the sequential judge-review screen and prompt with the track.

For music supplied by an artist, library, or marketplace, use
`docs/licensed-music.md` instead and retain written master, composition,
synchronization/interactive, commercial, excerpting, territory, and app-store
distribution rights.
