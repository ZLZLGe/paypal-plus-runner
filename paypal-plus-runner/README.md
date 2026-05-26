# PayPal Plus Roxy Runner

Non-extension runner for the PayPal Plus flow. The current implementation contains the database/importers, PayPal phone leasing, Roxy multi-window/CDP runtime, checkout profile generation, checkout conversion providers, and a PayPal Hosted Checkout state machine that reuses the original plugin PayPal content script.

## Commands

```bash
npm run db:init -- --db data/paypal_plus_runner.db
npm run import-outlook -- --db data/paypal_plus_runner.db --file mail.txt
npm run import-paypal-phones -- --db data/paypal_plus_runner.db --file /Users/leviviya/Documents/gpt/playwright/phone.txt
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
