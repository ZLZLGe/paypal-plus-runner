import { spawn } from "node:child_process";

const META_MARKER = "__PAYPAL_PLUS_CURL_META__";

function secondsFromMs(value, fallbackMs = 45000) {
  const ms = Math.max(1000, Number(value || fallbackMs));
  return String(Math.ceil(ms / 1000));
}

function buildHeaderArgs(headers = {}) {
  const args = [];
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null || value === "") continue;
    args.push("--header", `${key}: ${value}`);
  }
  return args;
}

function splitCurlOutput(stdout) {
  const markerIndex = stdout.lastIndexOf(META_MARKER);
  if (markerIndex < 0) {
    return { body: stdout, meta: { status: 0, urlEffective: "", remoteIp: "" } };
  }
  const body = stdout.slice(0, markerIndex);
  const rawMeta = stdout.slice(markerIndex + META_MARKER.length).trim();
  const [statusRaw, urlEffective = "", remoteIp = ""] = rawMeta.split("|");
  return {
    body,
    meta: {
      status: Number.parseInt(statusRaw, 10) || 0,
      urlEffective,
      remoteIp,
    },
  };
}

export async function curlRequest({
  url,
  method = "GET",
  headers = {},
  body = undefined,
  proxyUrl = "",
  timeoutMs = 45000,
  connectTimeoutMs = 15000,
  followRedirects = true,
  userAgent = "",
} = {}) {
  if (!url) throw new Error("curlRequest url is required");

  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    secondsFromMs(timeoutMs),
    "--connect-timeout",
    secondsFromMs(connectTimeoutMs, 15000),
    "--write-out",
    `${META_MARKER}%{http_code}|%{url_effective}|%{remote_ip}`,
    "--request",
    String(method || "GET").toUpperCase(),
  ];
  if (followRedirects) args.push("--location");
  if (proxyUrl) args.push("--proxy", proxyUrl);
  if (userAgent) args.push("--user-agent", userAgent);
  args.push(...buildHeaderArgs(headers));
  if (body !== undefined) args.push("--data-binary", "@-");
  args.push(url);

  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, Math.max(1000, Number(timeoutMs || 45000) + 2500));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const { body: responseBody, meta } = splitCurlOutput(stdout);
      if (code !== 0) {
        reject(new Error(`curl failed code=${code} signal=${signal || ""}: ${stderr || responseBody}`.slice(0, 2000)));
        return;
      }
      resolve({
        status: meta.status,
        urlEffective: meta.urlEffective,
        remoteIp: meta.remoteIp,
        text: responseBody,
        stderr,
      });
    });

    if (body !== undefined) {
      child.stdin.end(String(body));
    } else {
      child.stdin.end();
    }
  });
}
