export function createLogger(scope = "runner") {
  function write(level, message, meta = undefined) {
    const suffix = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
    process.stdout.write(`[${new Date().toISOString()}] [${level}] [${scope}] ${message}${suffix}\n`);
  }
  return {
    info: (message, meta) => write("INFO", message, meta),
    warn: (message, meta) => write("WARN", message, meta),
    error: (message, meta) => write("ERROR", message, meta),
    debug: (message, meta) => write("DEBUG", message, meta),
  };
}
