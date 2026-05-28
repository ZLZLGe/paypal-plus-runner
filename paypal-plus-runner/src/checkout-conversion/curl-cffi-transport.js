import { spawn } from "node:child_process";
import path from "node:path";

function secondsFromMs(value, fallbackMs = 45000) {
  const ms = Math.max(1000, Number(value || fallbackMs));
  return Math.ceil(ms / 1000);
}

function defaultPythonExecutable() {
  return path.resolve(".venv/bin/python");
}

function defaultScriptPath() {
  return path.resolve("scripts/curl_cffi_request.py");
}

export async function curlCffiRequest({
  url,
  method = "GET",
  headers = {},
  body = undefined,
  proxyUrl = "",
  timeoutMs = 45000,
  pythonExecutable = "",
  scriptPath = "",
  impersonate = "chrome136",
} = {}) {
  if (!url) throw new Error("curlCffiRequest url is required");

  const executable = pythonExecutable || defaultPythonExecutable();
  const script = scriptPath || defaultScriptPath();
  const payload = {
    url,
    method,
    headers,
    body,
    proxyUrl,
    timeoutSeconds: secondsFromMs(timeoutMs),
    impersonate,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, Math.max(1000, Number(timeoutMs || 45000) + 5000));

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
      let parsed = null;
      try {
        parsed = JSON.parse(stdout || "{}");
      } catch (error) {
        reject(new Error(`curl_cffi helper returned invalid JSON code=${code} signal=${signal || ""}: ${stdout || stderr || error.message}`.slice(0, 2000)));
        return;
      }
      if (code !== 0 || !parsed.ok) {
        reject(new Error(`curl_cffi failed code=${code} signal=${signal || ""}: ${parsed?.error || stderr || stdout}`.slice(0, 2000)));
        return;
      }
      resolve({
        status: Number.parseInt(parsed.status, 10) || 0,
        urlEffective: parsed.urlEffective || "",
        remoteIp: parsed.remoteIp || "",
        text: parsed.text || "",
        stderr,
        durationMs: parsed.durationMs,
        impersonate: parsed.impersonate || impersonate,
      });
    });

    child.stdin.end(JSON.stringify(payload));
  });
}
