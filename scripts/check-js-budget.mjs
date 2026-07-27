/**
 * Per-route client JS budget gate for Next.js App Router (Turbopack) builds.
 *
 * Measures **eager/initial** production chunks (page entry + shared + sync
 * deps) separately from **async/deferred** chunks (Turbopack e.v / Promise.all
 * load factories and next/dynamic client splits).
 *
 * Prior gates summed transitive async edges and treated that total as "first
 * load", which hid that optional islands (jsqr, admin tools) were already
 * deferred — or that server-side dynamic() had not deferred anything at all.
 *
 * No extra dependencies — Node stdlib only.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const DEFAULT_BUDGETS = "js-route-budgets.json";
const DEFAULT_NEXT_DIR = ".next";
const DEFAULT_ARTIFACT = ".scratch/remediation-71/route-chunk-map.json";

/**
 * Content markers that must not appear in eager (initial) chunks for routes
 * that are not supposed to ship optional heavy islands up front.
 * Checked against raw chunk source after a production build.
 */
export const OPTIONAL_MARKERS = {
  /**
   * jsqr library body (not mere property name `jsQR` on decode options).
   * Turbopack minifies `coefficientsLength` / `0x9C52` hex — use stable tokens:
   * - BitMatrix + VERSIONS (jsqr source identifiers retained in minified output)
   * - decimal forms of 0x9C52/0x9C53 (40018/40019) when hex is rewritten
   * - unminified source forms for local/dev bundles
   */
  jsqr_lib: {
    id: "jsqr_lib",
    test: (text) =>
      (text.includes("BitMatrix") && text.includes("VERSIONS")) ||
      (text.includes("40018") && text.includes("40019")) ||
      text.includes("coefficientsLength") ||
      (text.includes("0x9C52") && text.includes("0x9C53")),
    description: "jsqr decoder library",
  },
  /** qrcode.react SVG encoder used only on print slips. */
  qrcode_react: {
    id: "qrcode_react",
    test: (text) => text.includes("QRCodeSVG") || text.includes("qrcode.react"),
    description: "qrcode.react print helper",
  },
};

/** Routes where optional markers must stay out of the eager graph. */
export const ROUTE_FORBIDDEN_EAGER_MARKERS = {
  "/": ["jsqr_lib", "qrcode_react"],
  "/login": ["jsqr_lib", "qrcode_react"],
  "/register": ["jsqr_lib", "qrcode_react"],
  "/volunteer": ["jsqr_lib", "qrcode_react"],
  "/admin": ["jsqr_lib", "qrcode_react"],
  "/doctor": ["jsqr_lib", "qrcode_react"],
  "/admin/patients": ["jsqr_lib", "qrcode_react"],
  "/p/[id]": ["jsqr_lib", "qrcode_react"],
  "/s/[token]": ["jsqr_lib", "qrcode_react"],
  // Print routes may include qrcode_react eagerly (that is the page purpose).
  "/print/[id]": ["jsqr_lib"],
  "/print/prescription/[id]": ["jsqr_lib"],
};

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
 * Fail when optional heavy deps appear in eager route chunks.
 * @param {Array<{ route: string, initialChunks: string[], chunks?: string[] }>} measurements
 * @param {string} nextDir
 * @param {Record<string, string[]>} [forbiddenByRoute]
 */
export function checkEagerMarkers(
  measurements,
  nextDir,
  forbiddenByRoute = ROUTE_FORBIDDEN_EAGER_MARKERS,
) {
  /** @type {Array<{ route: string, marker: string, chunk: string, message: string }>} */
  const failures = [];
  const textCache = new Map();

  function textOf(rel) {
    if (textCache.has(rel)) return textCache.get(rel);
    const abs = path.join(nextDir, rel);
    if (!fs.existsSync(abs)) {
      textCache.set(rel, "");
      return "";
    }
    const t = fs.readFileSync(abs, "utf8");
    textCache.set(rel, t);
    return t;
  }

  for (const m of measurements) {
    const forbidden = forbiddenByRoute[m.route];
    if (!forbidden?.length) continue;
    const eager = m.initialChunks || m.chunks || [];
    for (const chunk of eager) {
      const text = textOf(chunk);
      if (!text) continue;
      for (const markerId of forbidden) {
        const marker = OPTIONAL_MARKERS[markerId];
        if (!marker) continue;
        if (marker.test(text)) {
          failures.push({
            route: m.route,
            marker: markerId,
            chunk,
            message: `Eager optional dependency: ${m.route} initial chunk ${chunk} contains ${marker.description} (${markerId})`,
          });
        }
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}

/**
 * @param {{ failures: Array<{ message: string }>, missingBudgets?: string[] }} result
 */
export function formatReport(result) {
  const lines = [];
  for (const f of result.failures || []) lines.push(f.message);
  for (const r of result.missingBudgets || []) {
    lines.push(`JS budget missing: ${r} has no entry in the budgets file`);
  }
  return lines.join("\n");
}

/**
 * Classify static/chunks references in a chunk as async (Turbopack deferred
 * load) vs sync (eager graph edge).
 * @param {string} text
 * @returns {{ asyncRefs: Set<string>, syncRefs: Set<string>, allRefs: Set<string> }}
 */
export function classifyChunkRefs(text) {
  const allRefs = new Set();
  for (const m of text.matchAll(/static\/chunks\/[A-Za-z0-9._-]+\.js/g)) {
    allRefs.add(m[0]);
  }

  const asyncRefs = new Set();
  // Turbopack async module factory: e.v(r => Promise.all(["static/chunks/..."].map(r => e.l(r)))
  for (const m of text.matchAll(
    /Promise\.all\(\[([^\]]*)\]\.map\(\s*[a-zA-Z_$][\w$]*\s*=>\s*[a-zA-Z_$][\w$]*\.l\s*\(/g,
  )) {
    for (const r of m[1].matchAll(/static\/chunks\/[A-Za-z0-9._-]+\.js/g)) {
      asyncRefs.add(r[0]);
    }
  }
  // Broader: any Promise.all([... "static/chunks/..." ...])
  for (const m of text.matchAll(
    /Promise\.all\(\[([^\]]*"static\/chunks\/[^"]+\.js"[^\]]*)\]/g,
  )) {
    for (const r of m[1].matchAll(/static\/chunks\/[A-Za-z0-9._-]+\.js/g)) {
      asyncRefs.add(r[0]);
    }
  }

  const syncRefs = new Set(
    [...allRefs].filter((r) => !asyncRefs.has(r)),
  );
  return { asyncRefs, syncRefs, allRefs };
}

/**
 * @param {string} nextDir
 * @returns {Array<{
 *   route: string,
 *   raw: number,
 *   gzip: number,
 *   chunks: string[],
 *   initialChunks: string[],
 *   deferredChunks: string[],
 *   initialRaw: number,
 *   initialGzip: number,
 *   deferredRaw: number,
 *   deferredGzip: number,
 *   frameworkRaw: number,
 *   frameworkGzip: number,
 *   appRaw: number,
 *   appGzip: number,
 * }>}
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
  const frameworkSet = new Set(shared);

  const chunkFiles = listStaticChunks(nextDir);
  const { syncGraph, asyncGraph, fullGraph } = buildChunkGraphs(
    nextDir,
    chunkFiles,
  );
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

    const initial = transitiveClosure([...entries], syncGraph, nextDir);
    const full = transitiveClosure([...entries], fullGraph, nextDir);
    const deferred = new Set(
      [...full].filter((c) => !initial.has(c)),
    );

    // Also collect async edges reachable from initial (direct optional loads).
    for (const c of initial) {
      for (const d of asyncGraph.get(c) || []) {
        if (!initial.has(d)) deferred.add(d);
        // Include further async children of deferred for reporting.
        const more = transitiveClosure([d], fullGraph, nextDir);
        for (const x of more) {
          if (!initial.has(x)) deferred.add(x);
        }
      }
    }

    let initialRaw = 0;
    let initialGzip = 0;
    let deferredRaw = 0;
    let deferredGzip = 0;
    let frameworkRaw = 0;
    let frameworkGzip = 0;
    let appRaw = 0;
    let appGzip = 0;

    const initialChunks = [...initial].sort();
    const deferredChunks = [...deferred].sort();
    // Budget uses eager/initial only (#71).
    for (const c of initialChunks) {
      const s = sizeOf(c);
      if (!s) continue;
      initialRaw += s.raw;
      initialGzip += s.gzip;
      if (frameworkSet.has(c)) {
        frameworkRaw += s.raw;
        frameworkGzip += s.gzip;
      } else {
        appRaw += s.raw;
        appGzip += s.gzip;
      }
    }
    for (const c of deferredChunks) {
      const s = sizeOf(c);
      if (!s) continue;
      deferredRaw += s.raw;
      deferredGzip += s.gzip;
    }

    results.push({
      route: routeFromManifestPath(manifest),
      // Primary budget fields = eager/initial first-load JS.
      raw: initialRaw,
      gzip: initialGzip,
      chunks: initialChunks,
      initialChunks,
      deferredChunks,
      initialRaw,
      initialGzip,
      deferredRaw,
      deferredGzip,
      frameworkRaw,
      frameworkGzip,
      appRaw,
      appGzip,
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
function buildChunkGraphs(nextDir, chunkFiles) {
  /** @type {Map<string, Set<string>>} */
  const syncGraph = new Map();
  /** @type {Map<string, Set<string>>} */
  const asyncGraph = new Map();
  /** @type {Map<string, Set<string>>} */
  const fullGraph = new Map();

  for (const rel of chunkFiles) {
    const text = fs.readFileSync(path.join(nextDir, rel), "utf8");
    const { asyncRefs, syncRefs, allRefs } = classifyChunkRefs(text);
    syncGraph.set(rel, syncRefs);
    asyncGraph.set(rel, asyncRefs);
    fullGraph.set(rel, allRefs);
  }
  return { syncGraph, asyncGraph, fullGraph };
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
 * Write machine-readable route/chunk map for browser tests and evidence.
 * @param {ReturnType<typeof measureRoutes>} measurements
 * @param {string} outPath
 * @param {string} nextDir
 */
export function writeRouteChunkArtifact(measurements, outPath, nextDir) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });

  // Identify which deferred chunks carry optional markers.
  const markerByChunk = {};
  for (const m of measurements) {
    for (const rel of [...m.initialChunks, ...m.deferredChunks]) {
      if (markerByChunk[rel]) continue;
      const abs = path.join(nextDir, rel);
      if (!fs.existsSync(abs)) continue;
      const text = fs.readFileSync(abs, "utf8");
      const hits = [];
      for (const [id, marker] of Object.entries(OPTIONAL_MARKERS)) {
        if (marker.test(text)) hits.push(id);
      }
      // Light scan UI without library body still useful for network asserts.
      if (
        text.includes("Open camera") ||
        text.includes("Opening camera")
      ) {
        hits.push("scanner_ui");
      }
      markerByChunk[rel] = hits;
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    measureMode: "eager-initial-vs-async-deferred",
    routes: Object.fromEntries(
      measurements.map((m) => [
        m.route,
        {
          initialGzip: m.initialGzip,
          initialRaw: m.initialRaw,
          deferredGzip: m.deferredGzip,
          deferredRaw: m.deferredRaw,
          frameworkGzip: m.frameworkGzip,
          appGzip: m.appGzip,
          initialChunks: m.initialChunks,
          deferredChunks: m.deferredChunks,
          deferredMarkers: Object.fromEntries(
            m.deferredChunks.map((c) => [c, markerByChunk[c] || []]),
          ),
          initialMarkers: Object.fromEntries(
            m.initialChunks.map((c) => [c, markerByChunk[c] || []]),
          ),
        },
      ]),
    ),
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return payload;
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
  let artifactRel = DEFAULT_ARTIFACT;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--budgets") budgetsRel = argv[++i];
    else if (a === "--next-dir") nextRel = argv[++i];
    else if (a === "--print") printOnly = true;
    else if (a === "--artifact") artifactRel = argv[++i];
    else if (a === "--help" || a === "-h") {
      log(
        "Usage: node scripts/check-js-budget.mjs [--budgets FILE] [--next-dir DIR] [--print] [--artifact FILE]",
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

  const artifactPath = path.resolve(cwd, artifactRel);
  try {
    writeRouteChunkArtifact(measurements, artifactPath, nextDir);
  } catch (e) {
    error(
      `Failed to write chunk artifact: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 2;
  }

  if (printOnly) {
    log("route\tinitial_raw\tinitial_gzip\tdeferred_raw\tdeferred_gzip");
    for (const m of measurements) {
      log(
        `${m.route}\t${m.initialRaw}\t${m.initialGzip}\t${m.deferredRaw}\t${m.deferredGzip}`,
      );
    }
    log(`# artifact ${artifactPath}`);
    return 0;
  }

  if (!fs.existsSync(budgetsPath)) {
    error(`Budgets file not found: ${budgetsPath}`);
    return 2;
  }

  const budgets = loadBudgets(budgetsPath);
  const result = checkBudgets(measurements, budgets);
  const markerResult = checkEagerMarkers(measurements, nextDir);

  log("JS route budgets (eager/initial gzipped bytes; deferred excluded):");
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
      `  ${status.padEnd(9)} ${m.route.padEnd(28)} initial=${String(m.initialGzip).padStart(8)} budget=${budgetCol.padStart(8)} deferred=${String(m.deferredGzip).padStart(8)} app=${m.appGzip} fw=${m.frameworkGzip}`,
    );
    if (m.deferredChunks.length) {
      log(
        `           deferred chunks: ${m.deferredChunks.map((c) => c.replace("static/chunks/", "")).join(", ")}`,
      );
    }
  }
  log(`Chunk map artifact: ${artifactPath}`);

  if (result.unusedBudgets.length) {
    log(
      `Note: budgets file has unused routes (not in this build): ${result.unusedBudgets.join(", ")}`,
    );
  }

  if (!markerResult.ok) {
    error(formatReport(markerResult));
  }

  if (!result.ok) {
    error(formatReport(result));
  }

  if (!result.ok || !markerResult.ok) {
    return 1;
  }

  log("All route JS budgets within limits; optional markers not eager.");
  return 0;
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2));
}
