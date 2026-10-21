# Commercial release readiness

Reviewed 28 September 2026. This is an engineering release assessment, not a
license, legal approval, provider certification, or app-store acceptance. Earlier
decision notes describe previous designs; they do not establish commercial rights.

## Improvements in this revision

- AI host accounts, one-time trials, five-round game credits, verified StoreKit
  purchases and refunds, Apple account revocation, and persistent spending
  reservations are implemented. See [billing setup](billing.md) for deployment
  secrets, Apple products and transaction notifications. Guests remain free.
- An AI round reveals only after every song succeeds. Failure switches the whole
  round to anonymous crowd voting and refunds its game credit once. Paid requests
  require a current game reservation. Rooms admit up to eight players.
- The frontend uses a light record-sleeve theme. AI-room guests explicitly consent
  before joining to sharing song metadata and optional defenses with OpenRouter
  and its model providers. This consent is required by the server, too.
- Native Swift sources parse successfully. A complete Xcode build is blocked on
  this machine by its missing CoreSimulator framework; run Xcode first-launch
  setup, then validate on a real device and in TestFlight before release.


- Reclaim requires the identity's existing Bearer token. Knowing a public room
  code and nickname cannot take over a disconnected player or host. Rotation is
  persisted, the previous token stops authenticating, and outstanding WebSocket
  tickets are bound to the current token hash. Kicked membership is persisted.
- Production ignores `AUX_DEV_MODE=1`, so the debug room listing is unavailable.
- The default iTunes song index omits promotional artwork and preview audio. Its
  manual and YouTube adapters also discard artwork supplied by an index. Resolved
  YouTube tracks use the selected video's own thumbnail.
- Focused automated tests cover these security and artwork boundaries. A runtime
  dependency audit (`npm audit --omit=dev`) found no reported vulnerabilities on
  the review date; this is not a complete security assessment.

## Required owner decisions before public monetization

1. **Music rights and business model.** Choose the launch providers and intended
   countries, and have the actual charging model and timed-excerpt experience
   reviewed against current agreements. An API key or embeddable video does not
   establish every right needed by a commercial game. Do not describe matching
   videos as guaranteed official recordings: the current resolver uses heuristics.

   YouTube prohibits charging users to watch its embedded player and imposes
   player, branding and data-handling conditions. Assess the paid game experience
   against the [YouTube Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
   and [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality),
   including how song metadata and search results are presented. Keep the real
   video player visible and accessible; do not extract audio or hide advertisements.

   Apple's [Search API terms](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html)
   restrict promotional artwork and previews to promoting store content, with an
   adjacent approved store badge. Removing artwork addresses that implementation
   issue; it does not independently approve all metadata use. For optional
   MusicKit, [App Review Guidelines 4.5.2](https://developer.apple.com/app-store/review/guidelines/#apple-sites-and-services)
   require user-controlled playback, restrict monetizing service access, and say
   more involved integrations may need separate rights.

   Keep Deezer previews disabled for commercial distribution unless a separate
   agreement covers the use. Its published [Developer Terms, IV](https://developers.deezer.com/termsofuse)
   limit the service to non-commercial use. Do not assume a free promotional demo
   automatically satisfies those terms. For publisher-owned audio, retain master
   and composition rights, territories, excerpt permissions and store-distribution
   evidence; manifest booleans are attestations, not verification of legal rights.

2. **Privacy and user terms.** Publish owner-approved terms and a privacy notice
   describing session storage, room data, logs, retention/deletion, provider
   requests, embedded media and AI processing. The current source has no complete
   acceptance flow. YouTube additionally requires privacy-policy agreement,
   accessible policy links, its Terms link and the Google Privacy Policy link
   under [Developer Policies III.A](https://developers.google.com/youtube/terms/developer-policies#iii.-general-developer-policies).
   Review age ratings, support contact and store privacy declarations for the
   final product. Do not substitute invented publisher details or a generic notice.

3. **A funded, observable AI service.** Set a valid server-side key, a supported
   model and a provider account spending limit. Run a small authorized smoke test
   against the deployed service before advertising live AI judging. Keep fallback
   results identifiable. The judge evaluates submitted metadata and scenario
   context; it does not listen to the audio. Persistent SQLite daily/monthly budgets now survive restarts. Retain a provider-side hard cap as a second boundary; configure the per-attempt hold for the selected model's maximum cost.

## Deployment checks before launch

- Keep one authoritative server process. Rooms, sockets, tickets and rate limits
  live in memory, and SQLite is local; adding replicas currently requires room
  affinity and shared coordination. Use persistent SQLite storage and exercise
  backup/restore and a reconnect during a deployment.
- Serve HTTPS, keep keys outside web/mobile bundles, restrict the backend to its
  trusted ingress, and verify client-IP handling before enabling proxy trust.
  Apply exact public origins in `AUX_ALLOWED_ORIGINS`.
- Set global room/member, provider quota and traffic budgets appropriate to load.
  The server caps each room at eight players and reserves provider spending persistently. Configure ingress and total-room capacity for expected traffic.
  Review actual YouTube quotas and request capacity through the official
  [quota process](https://developers.google.com/youtube/v3/getting-started#quota).
- Monitor persistence errors, disk growth, provider failures and fallback rate.
  `/healthz` only confirms process liveness; it cannot prove music playback,
  funded AI, or successful database writes. Checkpoints currently swallow write
  failures, so alerting on failed persistence still needs operational work.
- Exercise real iOS/Android and desktop browsers: background/reconnect, blocked
  autoplay, unavailable video, AI timeout, expired credentials and server restart.
  Automated provider fixtures do not prove live subscriptions, quotas or playback.

The release remains conditional on these owner decisions and deployment checks.
No deployment, provider purchase, live paid judging call or store submission was
performed by this review.
