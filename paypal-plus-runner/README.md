# PayPal Plus Roxy Runner

Non-extension runner for the PayPal Plus flow. The current implementation contains the database/importers, PayPal phone leasing, Roxy multi-window/CDP runtime, checkout profile generation, checkout conversion providers, and a PayPal Hosted Checkout state machine that reuses the original plugin PayPal content script.

## Commands

```bash
npm run db:init -- --db data/paypal_plus_runner.db
npm run import-outlook -- --db data/paypal_plus_runner.db --file mail.txt
npm run import-paypal-phones -- --db data/paypal_plus_runner.db --file /Users/leviviya/Documents/gpt/playwright/phone.txt
npm run db:stats -- --db data/paypal_plus_runner.db
npm run phones:list -- --db data/paypal_plus_runner.db --limit 20
npm run checkout:probe -- --config config.example.json
npm run roxy:probe -- --config config.example.json
npm run start -- --config config.example.json --windows 1 --limit 1 --dry-run
npm run start -- --config config.example.json --windows 3 --limit 6
```

## Phone Format

PayPal phones are imported from either format:

```text
+15722337281|http://a.62-us.com/api/get_sms?key=...
+14644009780----http://a.62-us.com/api/get_sms?key=...
```

The runner stores `phone` as `+1XXXXXXXXXX`, fills PayPal with the local 10-digit number, waits 10 seconds after the SMS send trigger, then polls `sms_url`.

## Current Runtime Notes

- `--windows` controls Roxy window concurrency; workers share one SQLite database and atomically lease one Outlook email plus one PayPal phone per run.
- `roxy.rotateProxyEveryAccounts` defaults to `3`, so a window can reuse the same proxy session for several accounts before Roxy proxy rotation.
- `runner.skipSignupSteps=true` skips the OpenAI signup form steps and expects an already logged-in Roxy profile or `runner.debugAccessToken`.
- With `runner.skipSignupSteps=false`, steps 2-5 reuse the original plugin `content/signup-page.js` protocol and fetch Outlook codes through MS_OAuth2API_Next.
- PayPal Hosted Checkout states handled now: `pay_login`, `guest_checkout`, `verification`, `review_consent`, `generic_error`, and `payments_success`.

## Local JP Checkout Conversion

`checkoutConversion.provider` can be switched between `cloud` and `local_jp_proxy`.

For the self-hosted route, `local_jp_proxy` supports two modes:

- `gost_chain`: starts a temporary local GOST proxy and chains `firstHopProxyUrl -> secondHopProxyUrl`. This matches the existing `/Users/leviviya/Documents/gpt/playwright` JP dynamic proxy setup.
- `direct_proxy_url`: sends checkout and Stripe init requests directly through the rendered `secondHopProxyUrl` with `curl --proxy`.

The local provider renders `{SID}` and `{ASN}`, probes the configured probe URL, requires JP exit by default, creates the ChatGPT checkout session, then initializes Stripe hosted checkout when ChatGPT does not already return a hosted PayPal URL.

## Failure Artifacts

On non-dry-run failure, the runner writes diagnostics under `output/<runId>/`:

- `failure.json` contains the email, PayPal phone, Roxy window, current step, URL, and error stack.
- `<step>.png` is a full-page screenshot when `runner.screenshotOnFailure=true`.
- `<step>.html` is the current page HTML when `runner.htmlSnapshotOnFailure=true`.

`run_history.artifact_dir` stores the artifact directory for quick lookup through `npm run db:stats`.
