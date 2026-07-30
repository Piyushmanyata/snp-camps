import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const roots = ["src", "scripts"].map((name) => path.join(root, name));
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const documented = new Set(
  [...envExample.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*(?:=|$)/gm)].map(
    ([, name]) => name,
  ),
);
const sourceFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:mjs|ts|tsx|js|jsx)$/.test(entry.name)) sourceFiles.push(file);
  }
}
for (const dir of roots) if (fs.existsSync(dir)) walk(dir);

const reads = new Map();
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    const name = match[1];
    if (!reads.has(name)) reads.set(name, file);
  }
}
const missing = [...reads.entries()]
  .filter(([name]) => !documented.has(name))
  .map(([name, file]) => `${name} (${path.relative(root, file)})`);
if (missing.length) {
  console.error(`ENV_DRIFT: undocumented environment reads\n${missing.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`check:env passed (${reads.size} static reads documented)`);
}
