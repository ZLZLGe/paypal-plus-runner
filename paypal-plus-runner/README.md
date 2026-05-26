# PayPal Plus Roxy Runner

Non-extension runner for the PayPal Plus flow. The current implementation contains the project foundation: database, importers, phone leasing, verification providers, checkout profile generation, checkout conversion providers, Roxy client, and workflow state-machine scaffolding.

## Commands

```bash
npm run db:init -- --db data/paypal_plus_runner.db
npm run import-outlook -- --db data/paypal_plus_runner.db --file mail.txt
npm run import-paypal-phones -- --db data/paypal_plus_runner.db --file /Users/leviviya/Documents/gpt/playwright/phone.txt
npm run start -- --config config.example.json --windows 1 --limit 1 --dry-run
```

## Phone Format

PayPal phones are imported from lines matching:

```text
+15722337281|http://a.62-us.com/api/get_sms?key=...
```

The runner stores `phone` as `+1XXXXXXXXXX`, fills PayPal with the local 10-digit number, waits 10 seconds after the SMS send trigger, then polls `sms_url`.
