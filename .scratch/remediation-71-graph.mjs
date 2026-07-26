import fs from "fs";
import path from "path";

// Trace how volunteer entry reaches scanner chunk via graph
const chunkDir = path.join(".next", "static", "chunks");
const files = fs.readdirSync(chunkDir).filter((n) => n.endsWith(".js"));
const graph = new Map();
for (const f of files) {
  const rel = "static/chunks/" + f;
  const text = fs.readFileSync(path.join(chunkDir, f), "utf8");
  const deps = new Set();
  for (const m of text.matchAll(/static\/chunks\/[A-Za-z0-9._-]+\.js/g)) deps.add(m[0]);
  graph.set(rel, deps);
}

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

const volunteerEntries = extract(".next/server/app/volunteer/page_client-reference-manifest.js");
const doctorEntries = extract(".next/server/app/doctor/page_client-reference-manifest.js");

function findPaths(entries, target) {
  const start = [...entries, ...shared];
  const prev = new Map();
  const q = [...start];
  const seen = new Set(start);
  while (q.length) {
    const cur = q.shift();
    if (cur === target) {
      const path = [cur];
      let p = prev.get(cur);
      while (p) {
        path.push(p);
        p = prev.get(p);
      }
      return path.reverse();
    }
    for (const d of graph.get(cur) || []) {
      if (seen.has(d)) continue;
      seen.add(d);
      prev.set(d, cur);
      q.push(d);
    }
  }
  return null;
}

const targets = [
  "static/chunks/3u12sj69_m676.js",
  "static/chunks/123jwzn4ybini.js",
  "static/chunks/22kvld0tl_bod.js",
  "static/chunks/2jwxwll9yqjnu.js",
];

for (const t of targets) {
  console.log("volunteer path to", t, "=>", findPaths(volunteerEntries, t));
  console.log("doctor path to", t, "=>", findPaths(doctorEntries, t));
}

// For each volunteer entry, show direct deps
console.log("\nVolunteer entry direct deps:");
for (const e of [...volunteerEntries].sort()) {
  console.log(e, "->", [...(graph.get(e) || [])]);
}

// Search for import() patterns that load jsqr module id
const scannerText = fs.readFileSync(".next/static/chunks/123jwzn4ybini.js", "utf8");
// look for dynamic load helpers
const samples = [];
for (const m of scannerText.matchAll(/.{0,40}import\(.{0,80}/g)) {
  samples.push(m[0].replace(/\n/g, " "));
}
console.log("\nimport( samples in doctor scanner chunk:");
console.log(samples.slice(0, 15).join("\n"));

// Does volunteer entry chunks reference scanner via module factory ids rather than path strings?
const volChunks = [...volunteerEntries, ...shared];
for (const c of volChunks) {
  const text = fs.readFileSync(path.join(".next", c), "utf8");
  if (/Open camera|jsQR|Mark seen/.test(text)) {
    console.log("VOL ENTRY CONTAINS SCANNER MARKERS:", c);
  }
}
