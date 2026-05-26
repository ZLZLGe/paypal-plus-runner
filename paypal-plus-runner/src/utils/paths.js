import path from "node:path";

export function resolvePath(filePath, cwd = process.cwd()) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}
