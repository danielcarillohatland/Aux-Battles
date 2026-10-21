# Host accounts and AI game packs

The server is the authority for accounts, game credits and AI spending. The iOS app receives an opaque host session and sends StoreKit's signed transaction to the server; it never receives the AI provider key. A signed-in host pays one credit to start an AI game, friends join free, and a game has a server-enforced round limit. Crowd practice requires no purchase.

## What ships in this implementation

- Sign in with Apple ID-token verification against Apple's fixed JWKS URL: RSA signature, issuer, configured audience, expiry, issued-at and a one-use server nonce. Each verified Apple subject gets the trial allowance once.
- Random 256-bit bearer sessions expire after seven days; only their SHA-256 hashes are stored. The billing database stores neither Apple identity tokens nor names, email addresses or raw Apple subjects. Refresh tokens obtained through Apple’s authorization-code exchange are encrypted with AES-256-GCM and bound to the account ID; account deletion revokes the Apple grant before removing the local account state.
- Durable SQLite transactions charge once per game, reject simultaneous active games for one host, enforce a daily host game quota and restore a credit once if AI judging fails. Refunded games cannot resume paid calls.
- App Store consumable game packs use Apple's official server library with trusted root certificates and online certificate checks. Bundle, environment, product, account token, purchase type, ownership and quantity must match. A transaction can fund exactly one account once.
- Signed App Store REFUND/REVOKE notifications deduct the purchased allowance once. Already-spent credits become debt; buying another pack first repays that debt. Refunds received before delivery also block later credit claims.
- Daily and monthly AI budgets are persisted in USD millionths. Every actual provider attempt, including a retry or backup model call, must reserve its full maximum estimated cost **before** network access. Reservations are atomic across database connections. Actual provider costs reconcile that reservation when available; uncertain costs and interrupted calls retain the entire reservation after restart.

The limits are additional protection, not a replacement for a provider-side key spending cap. Keep one billing database on a durable volume and run one application process until the game-state architecture supports multiple replicas. Back up the billing database using SQLite's online backup API or a consistent stopped-service copy that includes/checkpoints its WAL. Never reset it to restore trial allowances.

## Server configuration

Production sign-in stays disabled until authorization-exchange and refresh-token encryption credentials are configured. Keep the encryption key backed up with restricted access; changing it without re-encrypting existing grants prevents decryption and account deletion.

Configure deployment secrets and a durable `AUX_DB_FILE` according to the server composition root. The ledger constructor also accepts an explicit database path; `:memory:` is for automated tests only.

| Variable | Purpose / default |
| --- | --- |
| `AUX_APPLE_BUNDLE_ID` | Registered app bundle identifier; absent disables sign-in and purchases |
| `AUX_APPLE_SIGN_IN_AUDIENCE` | Allowed ID-token audience; defaults to the bundle ID for native sign-in |
| `AUX_APPLE_ENVIRONMENT` | `Production` by default; `Sandbox` permitted only outside `NODE_ENV=production` |
| `AUX_APPLE_TEAM_ID` | Apple developer team ID for authorization exchange/revocation |
| `AUX_APPLE_SIGN_IN_KEY_ID` | Sign in with Apple P8 signing key ID |
| `AUX_APPLE_SIGN_IN_PRIVATE_KEY_FILE` | Absolute path to the Sign in with Apple P8 private key |
| `AUX_APPLE_REFRESH_ENCRYPTION_KEY` | Base64-encoded random 32-byte AES key; keep durable and secret |
| `AUX_APPLE_APP_ID` | Numeric App Store application ID, required for production purchase verification |
| `AUX_APPLE_ROOT_CERT_FILES` | Comma-separated absolute paths to Apple root certificates in DER format |
| `AUX_APPLE_GAME_PRODUCTS` | JSON product allowlist, e.g. `{"com.yourcompany.aux.games5":5}` |
| `AUX_TRIAL_GAME_CREDITS` | One-time trial games per verified Apple subject; default `1` |
| `AUX_GAME_MAX_ROUNDS` | Rounds covered by one game credit; this release requires `5` |
| `AUX_HOST_DAILY_GAMES` | Started AI games per host per UTC day, including refunded games; default `10` |
| `AUX_AI_ATTEMPT_MAX_MICROS` | Worst-case USD millionths reserved per provider attempt; default `10000` ($0.01) |
| `AUX_AI_DAILY_BUDGET_MICROS` | Global daily AI budget in USD millionths; default `5000000` ($5) |
| `AUX_AI_MONTHLY_BUDGET_MICROS` | Global monthly AI budget; default `50000000` ($50) |

Per-call reserves must cover configured input and output limits for **every** allowed model/provider, provider fees and reasoning output if applicable. Updating model pricing requires reviewing this amount. An unexpectedly larger reported cost is still recorded in full and blocks later requests; no application budget can retroactively undo a provider charge. The request-count cap is only an additional guard. Leave the provider key with an independent hard spending limit.

Download roots from [Apple PKI](https://www.apple.com/certificateauthority/), verify their provenance and install them as deployment files. The server never trusts roots supplied by clients. Create actual consumable products in App Store Connect before enabling product IDs. Native StoreKit presents Apple's localized price; the server does not invent a retail price.

## iOS client contract

All paths below have the `/api/v1` prefix. Responses use `{ok:true,data:...}` or `{ok:false,error:{code,message}}`.

1. `GET /billing/config` returns availability, audience, product IDs/credits and game limits. Unsupported/unconfigured purchases remain visibly unavailable.
2. `POST /billing/challenge` returns `{challengeId,nonce,expiresAt}`. Put the returned **exact nonce** into the native `ASAuthorizationAppleIDRequest.nonce`; do not independently hash it. The server stores only a hash of this value.
3. `POST /billing/apple/session` with `{identityToken,challengeId,authorizationCode}` returns `{token,expiresAt,account}`. Store `token` in the iOS Keychain. `account` contains `{id,appAccountToken,credits,createdAt}`.
4. `GET /billing/account` uses `Authorization: Bearer <host session>`. The host-account token is separate from each room/player's token.
5. Purchase the selected StoreKit product with `.appAccountToken(UUID(uuidString: account.appAccountToken)!)`. This UUID is **not** `account.id`. Deliver `{signedTransaction: transaction.jwsRepresentation}` to `POST /billing/purchases` with the host bearer token. Finish the native transaction only after successful server delivery; a duplicate successful delivery is safe.
6. Recover unfinished consumable transactions after app restart and redeliver them before finishing. Purchased balance lives on the server and returns after signing in on another device.
7. `DELETE /billing/session` revokes the current session. `DELETE /billing/account` first revokes all stored encrypted Apple refresh tokens with Apple, then revokes all sessions, closes active AI games, removes positive credit balances, retains any refund debt and replaces the account purchase UUID. Minimal hashed identity and purchase/debt records remain to prevent replay/fraud; disclose the purpose and retention policy. Signing in again does not grant another trial. If Apple revocation fails, deletion returns an error and preserves account data for a retry; it never falsely reports successful deletion.

This backend implements native Apple sign-in. Browser sign-in is not enabled: adding it requires a properly registered Services ID, callback/state handling and Apple's authorization-code token exchange. Never use a user-entered Apple subject, device installation ID or a decoded-but-unverified JWT to grant credits.

## App Store notifications

Set the App Store Server Notifications V2 HTTPS URL to:

`https://YOUR_SERVER/api/v1/billing/apple/notifications`

Apple posts `{signedPayload}`. Signature verification and idempotent processing happen before changes. Other verified notification types receive success without changing balances. Delivery failures return an error so Apple can retry. Keep production and sandbox deployments, databases and provider budgets separate.

## Integration constraints

Use a unique billing game key for every room lifetime, such as `<roomCode>:<createdAt>`. `reserveGame(accountId,key)` is idempotent while active, and a completed/refunded key cannot authorize a new game. Room-code reuse must not reuse a previous billing reservation. `canContinueGame(key,roundIdx)` expects rounds numbered from 1.

`reserveAiAttempt({id,roomCode:key,maxCostMicros})` returns `true` only for a new committed reservation. A `false` return means the attempt already exists: **do not send another provider request**. Generate a new attempt ID for each deliberate network retry and reserve it separately. `settleAiAttempt(id,{costMicros,inputTokens,outputTokens})` settles once; omit unknown cost to keep the maximum charged. Catch database errors by choosing the unpaid round fallback, never by bypassing the budget.

## Release verification still required

Run real Sign in with Apple and StoreKit sandbox tests on an Apple-provisioned device; then test App Store Server Notifications V2 delivery, duplicate purchase recovery, refunds, app reinstall and server restart. Automated tests use local RSA keys and verifier seams; they do not prove the publisher's production configuration works. No live purchases or paid AI calls are made by these tests.

Test account deletion against the real Apple sandbox grant, including an Apple outage followed by retry. The server verifies the authorization-code exchange’s returned ID token matches the same subject and nonce, encrypts the refresh token, and revokes it before deleting local account access. Provision the Sign in with Apple key and encryption key before enabling production sign-in.

The product also needs final privacy disclosure/consent for sending song selections and defenses to the AI vendor, a support/refund policy, AI provider retention review, and verified music rights. These are publisher setup and review tasks, not fabricated configuration values.

References: [Apple account deletion and revocation](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple), [Apple identity verification](https://developer.apple.com/documentation/signinwithapple/verifying-a-user), [official App Store server library](https://github.com/apple/app-store-server-library-node), [Apple appAccountToken](https://developer.apple.com/documentation/appstoreserverapi/appaccounttoken).

## Operational metrics

Set a random `AUX_OPERATIONS_TOKEN` of at least 32 characters to enable
`GET /api/v1/operations/judge`. Send it as a Bearer token from an operator tool,
never from the browser or a mobile bundle. The response contains durable daily
and monthly spend, pending holds, success/failure totals, average transport
latency, model/prompt versions, and current provider health. It contains no
player defenses, account identity or provider keys. The endpoint is absent when
the token is unset. Provider transport success does not prove rubric quality;
validation failures are also visible through provider health.
