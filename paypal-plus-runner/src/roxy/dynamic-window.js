import { RoxyClient } from "./client.js";

export async function openDynamicRoxyWindow(config, name) {
  const client = new RoxyClient(config.roxy || {});
  return client.createAndOpen(name);
}
