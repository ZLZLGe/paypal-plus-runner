#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "./utils/args.js";
import { loadConfig, applyCliOverrides } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { importOutlookFile } from "./db/outlook-store.js";
import { importPaypalPhonesFile } from "./db/paypal-phone-store.js";
import { getDatabaseStats, listPaypalPhones } from "./db/stats.js";
import { runRunner } from "./runner.js";
import { probeLocalJpCheckoutProxy } from "./checkout-conversion/probe-local-jp.js";
import { probeRoxy } from "./roxy/probe.js";
import { stringifySafeJson } from "./utils/safe-output.js";

function commandFromArgv(argv) {
  if (argv[0] && !argv[0].startsWith("--")) {
    return { command: argv[0], rest: argv.slice(1) };
  }
  return { command: "start", rest: argv };
}

async function main() {
  const { command, rest } = commandFromArgv(process.argv.slice(2));
  const args = parseArgs(rest);
  const config = applyCliOverrides(loadConfig(args.config ? path.resolve(String(args.config)) : ""), args);
  const dbPath = String(args.db || config.database.path);

  if (command === "db:init") {
    const db = openDatabase(dbPath);
    initSchema(db);
    db.close();
    console.log(JSON.stringify({ ok: true, db: dbPath }, null, 2));
    return;
  }

  if (command === "import-outlook") {
    if (!args.file) throw new Error("--file is required");
    const db = openDatabase(dbPath);
    initSchema(db);
    const result = importOutlookFile(db, path.resolve(String(args.file)));
    db.close();
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  if (command === "import-paypal-phones") {
    if (!args.file) throw new Error("--file is required");
    const db = openDatabase(dbPath);
    initSchema(db);
    const result = importPaypalPhonesFile(db, path.resolve(String(args.file)), {
      maxUse: Number(config.paypalPhone?.maxUse || 5),
    });
    db.close();
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  if (command === "db:stats") {
    const db = openDatabase(dbPath);
    initSchema(db);
    const stats = getDatabaseStats(db);
    db.close();
    console.log(JSON.stringify({ ok: true, db: dbPath, ...stats }, null, 2));
    return;
  }

  if (command === "phones:list") {
    const db = openDatabase(dbPath);
    initSchema(db);
    const rows = listPaypalPhones(db, { limit: Number(args.limit || 50) });
    db.close();
    console.log(JSON.stringify({ ok: true, db: dbPath, phones: rows }, null, 2));
    return;
  }

  if (command === "checkout:probe") {
    const result = await probeLocalJpCheckoutProxy(config);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "roxy:probe") {
    const result = await probeRoxy(config);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "start") {
    const result = await runRunner(config, args);
    console.log(stringifySafeJson(result));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
