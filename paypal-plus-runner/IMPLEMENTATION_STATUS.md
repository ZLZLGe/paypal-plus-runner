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
  - local JP provider with `curl --proxy`
  - `direct_proxy_url` and temporary `gost_chain` modes
  - JP exit probe and optional strict JP validation
  - Stripe hosted checkout init fallback
- Roxy multi-window runtime:
  - create/open/recover Roxy windows
  - connect through Playwright CDP
  - optional exit IP probe
  - close/delete cleanup on exit
  - proxy rotation by account interval
- Workflow state machine with dry-run safety.
- ChatGPT signup step bridge:
  - injects original plugin `content/signup-page.js` dependencies
  - drives step 2 `submit-signup-email` through exact ChatGPT/OpenAI auth selectors and rejects third-party OAuth detours
  - drives step 3 `fill-password` via `EXECUTE_NODE`
  - gets Outlook code through MS_OAuth2API_Next provider and submits step 4 via `FILL_CODE`
  - drives step 5 `fill-profile` via `EXECUTE_NODE`
- Stripe hosted checkout enforcement:
  - requires long `https://checkout.stripe.com/c/pay/...` hosted checkout URLs by default
  - rejects short ChatGPT checkout links when hosted Stripe URL is required
  - retries hosted URL creation when checkout shows a non-zero due-today amount
- PayPal Hosted Checkout automation scaffold:
  - injects original plugin `content/utils.js`, `content/operation-delay.js`, and `content/paypal-flow.js`
  - handles PayPal stages `pay_login`, `guest_checkout`, `verification`, `review_consent`, `generic_error`
  - uses `paypal_phone_pool.sms_url` for PayPal SMS and waits 10 seconds before first poll
- PayPal risk detection for DataDome/risk-block pages under `paypal.com/agreements/approve`.
- Session JSON extraction from ChatGPT `/api/auth/session` plus storage fallback.
- Plus session validation before CPA JSON persistence.
- Optional SUB2API session JSON import.
- Tests for PayPal phone double format import and lease uniqueness.
- Failure artifacts under `output/<runId>/`, including `failure.json`, screenshot, and HTML snapshot.
- CLI diagnostics:
  - `db:stats`
  - `phones:list`
  - `checkout:probe`
  - `roxy:probe`

## Not Yet Implemented

- Additional recovery logic for page variants not covered by the original plugin scripts.

## Current Live Validation Status

Non-dry-run Roxy/ChatGPT/Stripe/PayPal E2E has been executed successfully through account signup, Outlook verification, Stripe hosted long checkout creation, and PayPal handoff. The latest 2026-05-28 single-account runs verified exact ChatGPT email selectors, Stripe `checkout.stripe.com/c/pay/...` hosted URLs, and 100% one-month free-trial Stripe discounts. The current live blocker is PayPal DataDome/risk blocking on `www.paypal.com/agreements/approve`, which the runner now detects as `PAYPAL_RISK_BLOCKED` and treats as retryable instead of saving CPA JSON or marking the account done.
