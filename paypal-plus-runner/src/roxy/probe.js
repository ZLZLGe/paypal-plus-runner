import { RoxyClient } from "./client.js";

export async function probeRoxy(config) {
  const roxy = config.roxy || {};
  const client = new RoxyClient(roxy);
  const startedAt = Date.now();
  const windows = await client.listWindows({ pageSize: Number(roxy.probePageSize || 20) });
  return {
    ok: true,
    apiBase: client.apiBase,
    workspaceId: client.workspaceId,
    windowCount: windows.length,
    sampleWindows: windows.slice(0, 5).map((row) => ({
      dirId: client.windowDirId(row),
      name: client.windowName(row),
      status: row.status || row.state || row.browserStatus || "",
    })),
    elapsedMs: Date.now() - startedAt,
  };
}
