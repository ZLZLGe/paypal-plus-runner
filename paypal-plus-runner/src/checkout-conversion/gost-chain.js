import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function isPortOpen(host, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function parseHostPort(proxyUrl) {
  const parsed = new URL(proxyUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
  };
}

function resolveGostExecutable(config = {}) {
  const candidates = [
    config.executable,
    "/opt/homebrew/bin/gost",
    "/usr/local/bin/gost",
    "gost",
  ].filter(Boolean);
  for (const item of candidates) {
    if (path.isAbsolute(item) && fs.existsSync(item)) return item;
  }
  return candidates[candidates.length - 1];
}

function readLogTail(logPath, maxChars = 1200) {
  try {
    return fs.readFileSync(logPath, "utf8").slice(-maxChars).trim();
  } catch {
    return "";
  }
}

export async function startGostChain({
  firstHopProxyUrl,
  secondHopProxyUrl,
  sid,
  localHost = "127.0.0.1",
  localPort = 0,
  startupTimeoutMs = 8000,
  portRetryAttempts = 5,
  executable = "",
} = {}) {
  const firstHop = String(firstHopProxyUrl || "").replaceAll("{SID}", String(sid || "")).trim();
  const secondHop = String(secondHopProxyUrl || "").replaceAll("{SID}", String(sid || "")).trim();
  if (!firstHop) throw new Error("checkoutConversion.localJpProxy.firstHopProxyUrl is empty");
  if (!secondHop) throw new Error("checkoutConversion.localJpProxy.secondHopProxyUrl is empty");
  if (!secondHop.includes(String(sid || ""))) {
    throw new Error("checkoutConversion.localJpProxy.secondHopProxyUrl must contain {SID}");
  }

  const { host: firstHost, port: firstPort } = parseHostPort(firstHop);
  if (!(await isPortOpen(firstHost, firstPort))) {
    throw new Error(`first hop proxy is not reachable: ${firstHop}`);
  }

  const explicitPort = Number(localPort || 0) > 0;
  const attempts = explicitPort ? 1 : Math.max(1, Number.parseInt(String(portRetryAttempts || 5), 10));
  const errors = [];
  const gostPath = resolveGostExecutable({ executable });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const listenPort = explicitPort ? Number(localPort) : await findFreePort(localHost);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paypal-plus-gost-"));
    const logPath = path.join(tempDir, "gost.log");
    const logFile = fs.openSync(logPath, "a");
    const listenUrl = `http://${localHost}:${listenPort}`;
    const child = spawn(gostPath, ["-L", listenUrl, "-F", firstHop, "-F", secondHop], {
      stdio: ["ignore", logFile, logFile],
      detached: false,
    });
    child.__gostLogFd = logFile;
    child.__gostLogPath = logPath;
    child.__gostSpawnError = null;
    child.once("error", (error) => {
      child.__gostSpawnError = error;
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < Number(startupTimeoutMs || 8000)) {
      if (child.__gostSpawnError) break;
      if (child.exitCode !== null) break;
      if (await isPortOpen(localHost, listenPort, 250)) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (child.exitCode === null) {
          return {
            process: child,
            proxyUrl: `http://${localHost}:${listenPort}`,
            pid: child.pid || 0,
            logPath,
            firstHop,
            secondHop,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    await stopGostChain({ process: child, logPath });
    const tail = readLogTail(logPath);
    const spawnError = child.__gostSpawnError ? ` spawn_error=${child.__gostSpawnError.message}` : "";
    errors.push(`attempt=${attempt}/${attempts} port=${listenPort} exit=${child.exitCode}${spawnError} log=${logPath} tail=${tail}`);
    if (explicitPort || !tail.toLowerCase().includes("address already in use")) break;
  }

  throw new Error(`gost chain failed to start: ${errors.join(" | ")}`);
}

export async function stopGostChain(chain) {
  const child = chain?.process || chain;
  if (!child) return undefined;
  if (child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
        resolve();
      }, 4000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (child.__gostLogFd !== undefined) {
    try {
      fs.closeSync(child.__gostLogFd);
    } catch {
      // The descriptor can already be closed when the process exits.
    }
  }
  return undefined;
}
