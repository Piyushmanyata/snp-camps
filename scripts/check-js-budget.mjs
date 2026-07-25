/**
 * Per-route client JS budget gate for Next.js App Router (Turbopack) builds.
 *
 * Reads .next build manifests, maps each page route to the static JS chunks it
 * loads (entry + transitive dynamic imports + shared root/polyfill), sums raw
 * and gzipped bytes, and fails if any route exceeds its gzipped budget.
 *
 * No extra dependencies — Node stdlib only.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const DEFAULT_BUDGETS = "js-route-budgets.json";
const DEFAULT_NEXT_DIR = ".next";

/**
 * @param {Array<{ route: string, raw: number, gzip: number }>} measurements
 * @param {Record<string, number>} budgets gzipped-byte budgets by route
 * @returns {{ ok: boolean, failures: Array<{ route: string, budget: number, actual: number, overage: number, message: string }>, missingBudgets: string[], unusedBudgets: string[] }}
 */
export function checkBudgets(measurements, budgets) {
  const failures = [];
  const missingBudgets = [];
  const measured = new Set(measurements.map((m) => m.route));

  for (const m of measurements) {
    const budget = budgets[m.route];
    if (budget === undefined) {
      missingBudgets.push(m.route);
      continue;
    }
    if (m.gzip > budget) {
      const overage = m.gzip - budget;
      failures.push({
        route: m.route,
        budget,
        actual: m.gzip,
        overage,
        message: `JS budget exceeded: ${m.route} budget=${budget} actual=${m.gzip} overage=${overage} (raw=${m.raw})`,
      });
    }
  }

  const unusedBudgets = Object.keys(budgets)
    .filter((r) => !measured.has(r))
    .sort();

  return {
    ok: failures.length === 0 && missingBudgets.length === 0,
    failures,
    missingBudgets,
    unusedBudgets,
  };
}

/**
 * @param {{ failures: Array<{ message: string }>, missingBudgets: string[] }} result
 */
export function formatReport(result) {
  const lines = [];
  for (const f of result.failures) lines.push(f.message);
  for (const r of result.missingBudgets) {
    lines.push(`JS budget missing: ${r} has no entry in the budgets file`);
  }
  return lines.join("\n");
}

/**
 * @param {string} nextDir
 * @returns {Array<{ route: string, raw: number, gzip: number, chunks: string[] }>}
 */
export function measureRoutes(nextDir) {
  const buildManifestPath = path.join(nextDir, "build-manifest.json");
  if (!fs.existsSync(buildManifestPath)) {
    throw new Error(
      `No build at ${nextDir} (missing build-manifest.json). Run \`npm run build\` first.`,
    );
  }

  const bm = JSON.parse(fs.readFileSync(buildManifestPath, "utf8"));
  const shared = [
    ...(bm.rootMainFiles || []),
    ...(bm.polyfillFiles || []),
  ];

  const chunkFiles = listStaticChunks(nextDir);
  const graph = buildChunkGraph(nextDir, chunkFiles);
  const sizeCache = new Map();

  function sizeOf(rel) {
    if (sizeCache.has(rel)) return sizeCache.get(rel);
    const abs = path.join(nextDir, rel);
    if (!fs.existsSync(abs)) {
      sizeCache.set(rel, null);
      return null;
    }
    const buf = fs.readFileSync(abs);
    const v = { raw: buf.length, gzip: zlib.gzipSync(buf).length };
    sizeCache.set(rel, v);
    return v;
  }

  const results = [];
  for (const manifest of walkPageClientManifests(
    path.join(nextDir, "server", "app"),
  )) {
    const entries = extractEntryChunks(manifest);
    for (const s of shared) entries.add(s);
    const all = transitiveClosure([...entries], graph, nextDir);
    let raw = 0;
    let gzip = 0;
    const chunks = [...all].sort();
    for (const c of chunks) {
      const s = sizeOf(c);
      if (!s) continue;
      raw += s.raw;
      gzip += s.gzip;
    }
    results.push({
      route: routeFromManifestPath(manifest),
      raw,
      gzip,
      chunks,
    });
  }

  results.sort((a, b) => a.route.localeCompare(b.route));
  return results;
}

/** @param {string} nextDir */
function listStaticChunks(nextDir) {
  const dir = path.join(nextDir, "static", "chunks");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".js"))
    .map((n) => `static/chunks/${n}`);
}

/**
 * @param {string} nextDir
 * @param {string[]} chunkFiles
 */
function buildChunkGraph(nextDir, chunkFiles) {
  /** @type {Map<string, Set<string>>} */
  const graph = new Map();
  for (const rel of chunkFiles) {
    const text = fs.readFileSync(path.join(nextDir, rel), "utf8");
    const deps = new Set();
    for (const m of text.matchAll(/static\/chunks\/[A-Za-z0-9._-]+\.js/g)) {
      deps.add(m[0]);
    }
    graph.set(rel, deps);
  }
  return graph;
}

/**
 * @param {string[]} entries
 * @param {Map<string, Set<string>>} graph
 * @param {string} nextDir
 */
function transitiveClosure(entries, graph, nextDir) {
  const out = new Set(entries);
  const q = [...entries];
  while (q.length) {
    const cur = q.pop();
    for (const d of graph.get(cur) || []) {
      if (out.has(d)) continue;
      if (!graph.has(d) && !fs.existsSync(path.join(nextDir, d))) continue;
      out.add(d);
      q.push(d);
    }
  }
  return out;
}

/** @param {string} manifestFile */
function extractEntryChunks(manifestFile) {
  const text = fs.readFileSync(manifestFile, "utf8");
  const chunks = new Set();
  for (const m of text.matchAll(/\/_next\/(static\/chunks\/[^"']+\.js)/g)) {
    chunks.add(m[1]);
  }
  for (const m of text.matchAll(/"(static\/chunks\/[^"']+\.js)"/g)) {
    chunks.add(m[1]);
  }
  return chunks;
}

/** @param {string} file */
function routeFromManifestPath(file) {
  const normalized = file.replaceAll("\\", "/");
  const marker = "/server/app/";
  const idx = normalized.indexOf(marker);
  let rel = idx >= 0 ? normalized.slice(idx + marker.length) : normalized;
  rel = rel.replace(/\/?page_client-reference-manifest\.js$/, "");
  if (!rel || rel === "page") return "/";
  return `/${rel}`;
}

/** @param {string} dir @param {string[]} [acc] */
function walkPageClientManifests(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkPageClientManifests(p, acc);
    else if (e.name.endsWith("page_client-reference-manifest.js")) acc.push(p);
  }
  return acc;
}

/**
 * Round measured gzip up slightly so the gate freezes current state without
 * failing on tiny zlib variance across machines.
 * @param {number} gzip
 */
export function budgetFromMeasured(gzip) {
  return Math.ceil((gzip * 1.03) / 1000) * 1000;
}

/** @param {string} budgetsPath */
export function loadBudgets(budgetsPath) {
  const raw = JSON.parse(fs.readFileSync(budgetsPath, "utf8"));
  if (raw && typeof raw === "object" && raw.routes && typeof raw.routes === "object") {
    return /** @type {Record<string, number>} */ (raw.routes);
  }
  return /** @type {Record<string, number>} */ (raw);
}

/**
 * CLI entry. Exported for tests.
 * @param {string[]} argv
 * @param {{ cwd?: string, log?: (s: string) => void, error?: (s: string) => void }} [opts]
 * @returns {number} exit code
 */
export function main(argv, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log ?? console.log;
  const error = opts.error ?? console.error;

  let budgetsRel = DEFAULT_BUDGETS;
  let nextRel = DEFAULT_NEXT_DIR;
  let printOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--budgets") budgetsRel = argv[++i];
    else if (a === "--next-dir") nextRel = argv[++i];
    else if (a === "--print") printOnly = true;
    else if (a === "--help" || a === "-h") {
      log(
        "Usage: node scripts/check-js-budget.mjs [--budgets FILE] [--next-dir DIR] [--print]",
      );
      return 0;
    }
  }

  const nextDir = path.resolve(cwd, nextRel);
  const budgetsPath = path.resolve(cwd, budgetsRel);

  let measurements;
  try {
    measurements = measureRoutes(nextDir);
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  if (printOnly) {
    log("route\traw\tgzip");
    for (const m of measurements) {
      log(`${m.route}\t${m.raw}\t${m.gzip}`);
    }
    return 0;
  }

  if (!fs.existsSync(budgetsPath)) {
    error(`Budgets file not found: ${budgetsPath}`);
    return 2;
  }

  const budgets = loadBudgets(budgetsPath);
  const result = checkBudgets(measurements, budgets);

  log("JS route budgets (gzipped bytes):");
  for (const m of measurements) {
    const budget = budgets[m.route];
    const status =
      budget === undefined
        ? "NO BUDGET"
        : m.gzip > budget
          ? "FAIL"
          : "ok";
    const budgetCol = budget === undefined ? "-" : String(budget);
    log(
      `  ${status.padEnd(9)} ${m.route.padEnd(28)} actual=${String(m.gzip).padStart(8)} budget=${budgetCol.padStart(8)} raw=${m.raw}`,
    );
  }

  if (result.unusedBudgets.length) {
    log(
      `Note: budgets file has unused routes (not in this build): ${result.unusedBudgets.join(", ")}`,
    );
  }

  if (!result.ok) {
    error(formatReport(result));
    return 1;
  }

  log("All route JS budgets within limits.");
  return 0;
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2));
}
