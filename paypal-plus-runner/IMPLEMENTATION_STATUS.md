# Implementation Status

## Completed

- Project skeleton and CLI.
- SQLite schema for `outlook_emails`, `plus_accounts`, `paypal_phone_pool`, and `run_history`.
- Outlook email importer for `email----password----client_id----refresh_token`.
- PayPal phone importer for `/Users/leviviya/Documents/gpt/playwright/phone.txt` formats: `+1XXXXXXXXXX|sms_url` and `+1XXXXXXXXXX----sms_url`.
- PayPal phone lease/release logic with SQLite `BEGIN IMMEDIATE`.
- PayPal SMS parsing for `no` and `yes|message`.
- Required 10-second initial delay support before polling PayPal SMS.
- Checkout profile generation compatible with plugin behavior:
  - random guest email/password
  - `James Smith`
  - PayPal local 10-digit phone
  - meiguodizhi/fallback address
  - generated Visa-like Luhn card
- Checkout conversion provider interfaces:
  - cloud provider compatible with plugin service
  - local JP provider scaffold
- Roxy multi-window runtime:
  - create/open/recover Roxy windows
  - connect through Playwright CDP
  - optional exit IP probe
  - close/delete cleanup on exit
  - proxy rotation by account interval
- Workflow state machine with dry-run safety.
- ChatGPT signup step bridge:
  - injects original plugin `content/signup-page.js` dependencies
  - drives step 2 `submit-signup-email` via `EXECUTE_NODE`
  - drives step 3 `fill-password` via `EXECUTE_NODE`
  - gets Outlook code through MS_OAuth2API_Next provider and submits step 4 via `FILL_CODE`
  - drives step 5 `fill-profile` via `EXECUTE_NODE`
- PayPal Hosted Checkout automation scaffold:
  - injects original plugin `content/utils.js`, `content/operation-delay.js`, and `content/paypal-flow.js`
  - handles PayPal stages `pay_login`, `guest_checkout`, `verification`, `review_consent`, `generic_error`
  - uses `paypal_phone_pool.sms_url` for PayPal SMS and waits 10 seconds before first poll
- Session JSON extraction from ChatGPT `/api/auth/session` plus storage fallback.
- Optional SUB2API session JSON import.
- Tests for PayPal phone double format import and lease uniqueness.

## Not Yet Implemented

- GOST transport adapter for local JP conversion.
- Real-site end-to-end validation on Roxy/ChatGPT/PayPal.
- Additional recovery logic for page variants not covered by the original plugin scripts.

Non-dry-run can open Roxy/CDP and run the implemented workflow. The first seven PayPal Plus Hosted Checkout steps are now wired through the original plugin content scripts; they still need live validation because selector behavior depends on current ChatGPT/PayPal pages.
