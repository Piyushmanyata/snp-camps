import fs from "fs";
import path from "path";

function extract(manifestPath) {
  const text = fs.readFileSync(manifestPath, "utf8");
  const chunks = new Set();
  for (const m of text.matchAll(/\/_next\/(static\/chunks\/[^"']+\.js)/g)) chunks.add(m[1]);
  for (const m of text.matchAll(/"(static\/chunks\/[^"']+\.js)"/g)) chunks.add(m[1]);
  return [...chunks].sort();
}

const routes = {
  volunteer: ".next/server/app/volunteer/page_client-reference-manifest.js",
  doctor: ".next/server/app/doctor/page_client-reference-manifest.js",
  admin: ".next/server/app/admin/page_client-reference-manifest.js",
  register: ".next/server/app/register/page_client-reference-manifest.js",
  print: ".next/server/app/print/[id]/page_client-reference-manifest.js",
  login: ".next/server/app/login/page_client-reference-manifest.js",
};

const bm = JSON.parse(fs.readFileSync(".next/build-manifest.json", "utf8"));
console.log("rootMainFiles", bm.rootMainFiles);
console.log("polyfillFiles", bm.polyfillFiles);

for (const [name, p] of Object.entries(routes)) {
  if (!fs.existsSync(p)) {
    console.log(name, "NO MANIFEST");
    continue;
  }
  const chunks = extract(p);
  console.log("\n==", name, "entry chunks", chunks.length);
  for (const c of chunks) {
    const abs = path.join(".next", c);
    const size = fs.existsSync(abs) ? fs.statSync(abs).size : -1;
    console.log(" ", c, "size=" + size);
  }
}

// Graph deps for scanner chunks
const scannerChunks = [
  "static/chunks/3u12sj69_m676.js",
  "static/chunks/123jwzn4ybini.js",
];
for (const c of scannerChunks) {
  const text = fs.readFileSync(path.join(".next", c), "utf8");
  const dynChunks = [...text.matchAll(/static\/chunks\/[A-Za-z0-9._-]+\.js/g)].map(
    (m) => m[0],
  );
  console.log("\n---", c, "size", text.length);
  console.log("static/chunks refs:", [...new Set(dynChunks)]);
  console.log("contains jsQR:", /jsQR/.test(text));
  // sample around jsQR
  const idx = text.indexOf("jsQR");
  if (idx >= 0) console.log("context:", text.slice(Math.max(0, idx - 80), idx + 80).replace(/\n/g, " "));
}

// Check whether jsqr is a separate module that could be split
// Search all chunks for only-jsqr content
const dir = ".next/static/chunks";
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  if (/jsQR/.test(text) && !/Open camera/.test(text)) {
    console.log("JSQR-ONLY-ISH", f, text.length);
  }
}
