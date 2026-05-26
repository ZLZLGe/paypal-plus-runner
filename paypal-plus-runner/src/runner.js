import { openDatabase } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { countAvailableOutlook } from "./db/outlook-store.js";
import { countAvailablePaypalPhones } from "./db/paypal-phone-store.js";
import { Worker } from "./worker.js";
import { createLogger } from "./logger.js";

export async function runRunner(config, args = {}) {
  const logger = createLogger("runner");
  const db = openDatabase(config.database.path);
  initSchema(db);

  const availableEmails = countAvailableOutlook(db);
  const availablePhones = countAvailablePaypalPhones(db);
  const requestedWindows = Number(args.windows || config.roxy?.windowCount || 5);
  const limit = Number(args.limit || 0);
  const dryRun = Boolean(args["dry-run"] || args.dryRun);

  logger.info("startup snapshot", {
    availableEmails,
    availablePhones,
    requestedWindows,
    limit,
    dryRun,
  });

  if (availableEmails <= 0) return { status: "empty", reason: "no_outlook_emails" };
  if (availablePhones <= 0) return { status: "empty", reason: "no_paypal_phones" };

  if (!dryRun) {
    throw new Error("browser automation is scaffolded but not enabled yet; rerun with --dry-run or implement steps");
  }

  const worker = new Worker({
    id: "worker_1",
    db,
    config,
    logger: createLogger("worker_1"),
    dryRun,
  });
  const results = await worker.runLoop({ limit: limit > 0 ? limit : 1 });
  db.close();
  return { status: "ok", results };
}
