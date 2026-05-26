export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const raw = item.slice(2);
    if (raw.startsWith("no-")) {
      args[raw.slice(3)] = false;
      continue;
    }
    const eqIndex = raw.indexOf("=");
    if (eqIndex >= 0) {
      args[raw.slice(0, eqIndex)] = raw.slice(eqIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[raw] = next;
      index += 1;
    } else {
      args[raw] = true;
    }
  }
  return args;
}

export function asInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}
