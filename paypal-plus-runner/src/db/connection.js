import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(dbPath) {
  const resolved = path.resolve(dbPath || "data/paypal_plus_runner.db");
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA foreign_keys=ON;");
  return db;
}

export function utcNow() {
  return new Date().toISOString();
}
