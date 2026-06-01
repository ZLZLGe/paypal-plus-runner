import { openDatabase } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { countAvailableOutlook } from "./db/outlook-store.js";
import { countAvailablePaypalPhones, normalizePaypalPhoneCountryCodes } from "./db/paypal-phone-store.js";
import { countReusableGptPhoneAccounts } from "./db/gpt-phone-account-store.js";
import { Worker } from "./worker.js";
import { createLogger } from "./logger.js";
import { createRoxyWindowPool } from "./roxy/window-pool.js";

function isSmsOauthFlow(config = {}) {
  return String(config.flow?.plusAccountAccessStrategy || "").trim().toLowerCase() === "sms_oauth";
}

export async function runRunner(config, args = {}) {
  const logger = createLogger("runner");
  const db = openDatabase(config.database.path);
  initSchema(db);

  const availableEmails = countAvailableOutlook(db);
  const reusableGptPhoneAccounts = countReusableGptPhoneAccounts(db);
  const paypalPhoneCountryCodes = normalizePaypalPhoneCountryCodes(config.paypalPhone?.countryCodes || ["JP"]);
  const availablePhones = countAvailablePaypalPhones(db, {
    countryCodes: paypalPhoneCountryCodes,
  });
  const requestedWindows = Number(args.windows || config.roxy?.windowCount || 5);
  const limit = Number(args.limit || 0);
  const dryRun = Boolean(args["dry-run"] || args.dryRun);

  logger.info("startup snapshot", {
    availableEmails,
    reusableGptPhoneAccounts,
    availablePhones,
    paypalPhoneCountryCodes,
    requestedWindows,
    limit,
    dryRun,
  });

  db.close();

  const deferOutlookLease = isSmsOauthFlow(config);
  if (!deferOutlookLease && availableEmails <= 0) return { status: "empty", reason: "no_outlook_emails" };
  if (!deferOutlookLease && availablePhones <= 0) return { status: "empty", reason: "no_paypal_phones" };

  if (dryRun) {
    const worker = new Worker({
      id: "worker_1",
      config,
      logger: createLogger("worker_1"),
      dryRun,
    });
    const results = await worker.runLoop({ limit: limit > 0 ? limit : 1 });
    return { status: "ok", mode: "dry_run", results };
  }

  const effectiveWindows = Math.max(1, Math.min(
    requestedWindows,
    deferOutlookLease ? requestedWindows : availableEmails,
    deferOutlookLease ? requestedWindows : availablePhones,
  ));
  const pool = await createRoxyWindowPool(config, { count: effectiveWindows, logger });
  const windows = pool.all().map((item) => {
    item.client = pool.client;
    return item;
  });
  const perWorkerLimit = limit > 0 ? Math.max(1, Math.ceil(limit / windows.length)) : 0;
  const startedAt = Date.now();
  let preserveWindowsForInspection = false;
  try {
    const results = await Promise.all(windows.map(async (windowInfo, index) => {
      const workerId = `worker_${index + 1}`;
      const worker = new Worker({
        id: workerId,
        config,
        logger: createLogger(workerId),
        dryRun,
        windowInfo,
      });
      try {
        const workerResult = {
          workerId,
          dirId: windowInfo.dirId,
          results: await worker.runLoop({ limit: perWorkerLimit }),
        };
        if (workerResult.results.some((item) => item?.preserveBrowserWindow === true)) {
          preserveWindowsForInspection = true;
        }
        return workerResult;
      } catch (error) {
        if (error?.preserveBrowserWindow === true) {
          preserveWindowsForInspection = true;
        }
        throw error;
      }
    }));
    return {
      status: "ok",
      mode: "roxy",
      requestedWindows,
      effectiveWindows,
      elapsedMs: Date.now() - startedAt,
      results,
    };
  } finally {
    if (preserveWindowsForInspection) {
      logger.warn("roxy cleanup skipped to preserve browser window for inspection");
    } else if (config.roxy?.closeWindowsOnExit !== false) {
      const cleanup = await pool.closeAll({ deleteWindows: config.roxy?.deleteWindowsOnExit === true });
      logger.info("roxy cleanup complete", cleanup);
    }
  }
}
