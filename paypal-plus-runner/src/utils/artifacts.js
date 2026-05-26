import fs from "node:fs/promises";
import path from "node:path";

function safeName(value) {
  return String(value || "artifact").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

async function ensureRunDir(config, runId) {
  const baseDir = path.resolve(String(config.output?.dir || "output"));
  const dir = path.join(baseDir, safeName(runId || `run_${Date.now()}`));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function writeFailureArtifacts(context, error, { logger } = {}) {
  const runId = context?.runId || `run_${Date.now()}`;
  const page = context?.page || null;
  const config = context?.config || {};
  const dir = await ensureRunDir(config, runId);
  const step = safeName(error?.step || context?.currentStep || "unknown_step");
  const metaPath = path.join(dir, "failure.json");
  const artifact = {
    runId,
    dir,
    workerId: context?.workerId || "",
    step: error?.step || context?.currentStep || "",
    email: context?.account?.email || "",
    paypalPhoneId: context?.phoneLease?.id || "",
    paypalPhone: context?.phoneLease?.phone || "",
    paypalLocalPhone: context?.checkoutProfile?.phone?.paypalLocal || "",
    roxyDirId: context?.windowInfo?.dirId || "",
    roxyExitIp: context?.windowInfo?.exitIp || "",
    url: "",
    error: {
      name: error?.name || "Error",
      message: error?.message || String(error || ""),
      stack: error?.stack || "",
    },
    files: {},
    createdAt: new Date().toISOString(),
  };

  try {
    artifact.url = page?.url?.() || "";
  } catch {
    artifact.url = "";
  }

  if (page && config.runner?.screenshotOnFailure !== false) {
    const screenshotPath = path.join(dir, `${step}.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      artifact.files.screenshot = screenshotPath;
    } catch (screenshotError) {
      artifact.files.screenshotError = screenshotError.message;
    }
  }

  if (page && config.runner?.htmlSnapshotOnFailure !== false) {
    const htmlPath = path.join(dir, `${step}.html`);
    try {
      const html = await page.content();
      await fs.writeFile(htmlPath, html, "utf8");
      artifact.files.html = htmlPath;
    } catch (htmlError) {
      artifact.files.htmlError = htmlError.message;
    }
  }

  await fs.writeFile(metaPath, JSON.stringify(artifact, null, 2), "utf8");
  artifact.files.meta = metaPath;
  logger?.warn?.("failure artifacts written", {
    runId,
    step: artifact.step,
    dir,
    screenshot: artifact.files.screenshot || "",
    html: artifact.files.html || "",
  });
  return artifact;
}
