import fs from "fs";
import path from "path";

const chunkDir = path.join(".next", "static", "chunks");
const files = fs.readdirSync(chunkDir).filter((n) => n.endsWith(".js"));

// Classify each static/chunks reference as async (e.v/e.l load) or sync
function classifyRefs(text) {
  const asyncRefs = new Set();
  const allRefs = new Set();
  for (const m of text.matchAll(/static\/chunks\/[A-Za-z0-9._-]+\.js/g)) {
    allRefs.add(m[0]);
  }
  // Turbopack async: e.v(...Promise.all(["static/chunks/..."].map(...e.l
  for (const m of text.matchAll(
    /e\.v\(\s*[a-z]\s*=>\s*Promise\.all\(\[([^\]]*)\]\.map\([a-z]\s*=>\s*[a-z]\.l/g,
  )) {
    for (const r of m[1].matchAll(/static\/chunks\/[A-Za-z0-9._-]+\.js/g)) {
      asyncRefs.add(r[0]);
    }
  }
  // Also broader: Promise.all(["static/chunks/...
  for (const m of text.matchAll(
    /Promise\.all\(\[([^\]]*"static\/chunks\/[^"]+\.js"[^\]]*)\]/g,
  )) {
    for (const r of m[1].matchAll(/static\/chunks\/[A-Za-z0-9._-]+\.js/g)) {
      asyncRefs.add(r[0]);
    }
  }
  const syncRefs = [...allRefs].filter((r) => !asyncRefs.has(r));
  return { allRefs: [...allRefs], asyncRefs: [...asyncRefs], syncRefs };
}

for (const f of ["36tt448q--qxs.js", "3u12sj69_m676.js", "123jwzn4ybini.js", "40alqurq0nwkt.js", "1mba_3_mu76on.js"]) {
  const text = fs.readFileSync(path.join(chunkDir, f), "utf8");
  const c = classifyRefs(text);
  console.log("\n", f);
  console.log("  async:", c.asyncRefs);
  console.log("  sync:", c.syncRefs);
}

// Measure INITIAL only for routes
function extract(manifestPath) {
  const text = fs.readFileSync(manifestPath, "utf8");
  const chunks = new Set();
  for (const m of text.matchAll(/\/_next\/(static\/chunks\/[^"']+\.js)/g)) chunks.add(m[1]);
  for (const m of text.matchAll(/"(static\/chunks\/[^"']+\.js)"/g)) chunks.add(m[1]);
  return chunks;
}

const shared = [
  "static/chunks/3bw4nm4ha4qou.js",
  "static/chunks/21u51kcu-3-i8.js",
  "static/chunks/3hdj40qmts5sf.js",
  "static/chunks/3ze9nkq3ic5bd.js",
  "static/chunks/turbopack-33ttaqp7yv_5q.js",
  "static/chunks/0cz1d0mv5g_q7.js",
];

const graphSync = new Map();
const graphAsync = new Map();
for (const f of files) {
  const rel = "static/chunks/" + f;
  const text = fs.readFileSync(path.join(chunkDir, f), "utf8");
  const c = classifyRefs(text);
  graphSync.set(rel, new Set(c.syncRefs));
  graphAsync.set(rel, new Set(c.asyncRefs));
}

function closure(entries, graph) {
  const out = new Set(entries);
  const q = [...entries];
  while (q.length) {
    const cur = q.pop();
    for (const d of graph.get(cur) || []) {
      if (out.has(d)) continue;
      out.add(d);
      q.push(d);
    }
  }
  return out;
}

import zlib from "zlib";
function sizeOf(rel) {
  const abs = path.join(".next", rel);
  if (!fs.existsSync(abs)) return { raw: 0, gzip: 0 };
  const buf = fs.readFileSync(abs);
  return { raw: buf.length, gzip: zlib.gzipSync(buf).length };
}

const routes = {
  "/volunteer": ".next/server/app/volunteer/page_client-reference-manifest.js",
  "/doctor": ".next/server/app/doctor/page_client-reference-manifest.js",
  "/admin": ".next/server/app/admin/page_client-reference-manifest.js",
  "/register": ".next/server/app/register/page_client-reference-manifest.js",
  "/print/[id]": ".next/server/app/print/[id]/page_client-reference-manifest.js",
  "/login": ".next/server/app/login/page_client-reference-manifest.js",
};

console.log("\n=== INITIAL vs FULL TRANSITIVE ===");
for (const [route, man] of Object.entries(routes)) {
  const entries = [...extract(man), ...shared];
  const initial = closure(entries, graphSync);
  // full: walk sync+async
  const fullGraph = new Map();
  for (const [k, v] of graphSync) {
    fullGraph.set(k, new Set([...v, ...(graphAsync.get(k) || [])]));
  }
  const full = closure(entries, fullGraph);
  let iRaw=0,iGzip=0,fRaw=0,fGzip=0;
  for (const c of initial) { const s=sizeOf(c); iRaw+=s.raw; iGzip+=s.gzip; }
  for (const c of full) { const s=sizeOf(c); fRaw+=s.raw; fGzip+=s.gzip; }
  const asyncOnly = [...full].filter(c => !initial.has(c));
  console.log(route);
  console.log("  initial gzip", iGzip, "chunks", initial.size);
  console.log("  full gzip", fGzip, "chunks", full.size);
  console.log("  deferred:", asyncOnly.map(c => c.replace("static/chunks/","")+"@"+sizeOf(c).raw).join(", ") || "(none)");
}
