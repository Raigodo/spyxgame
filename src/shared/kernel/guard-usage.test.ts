import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL("../..", import.meta.url));
const ALLOWED = join(srcRoot, "shared", "kernel", "guards.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

it("isRecord and isInt are defined only in kernel/guards.ts", () => {
  const offenders = sourceFiles(srcRoot).filter(
    (file) =>
      file !== ALLOWED && /\b(const|function)\s+(isRecord|isInt)\b/.test(readFileSync(file, "utf8"))
  );
  expect(offenders).toEqual([]);
});
