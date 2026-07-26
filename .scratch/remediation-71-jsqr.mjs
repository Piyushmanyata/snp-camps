import fs from "fs";

function analyze(file) {
  const text = fs.readFileSync(file, "utf8");
  console.log("\n===", file, "size", text.length);
  console.log("jsQR count", (text.match(/jsQR/g) || []).length);
  console.log("has Uint8ClampedArray decode signature-ish", /Uint8ClampedArray/.test(text));
  // jsqr library has distinctive strings
  console.log("has 'Could not find' or bit matrix?", /bitMatrix|BitMatrix|finder pattern|QR code/i.test(text));
  console.log("import( for jsqr?", /import\([^)]*jsqr/i.test(text));
  // dynamic import patterns in turbopack
  const dyn = [...text.matchAll(/__turbopack_async_import__|__turbopack_import__|t\.i\(|t\.A\(/g)].slice(0,5);
  console.log("turbopack import helpers", dyn.map(d=>d[0]));
  // Look for load of external chunk
  const chunkRefs = [...new Set([...text.matchAll(/static\/chunks\/[A-Za-z0-9._-]+\.js/g)].map(m=>m[0]))];
  console.log("chunk refs", chunkRefs);
  // sample around first jsQR
  let idx = 0;
  let n = 0;
  while ((idx = text.indexOf("jsQR", idx)) !== -1 && n < 3) {
    console.log("ctx"+n+":", JSON.stringify(text.slice(Math.max(0,idx-60), idx+100)));
    idx += 4; n++;
  }
}

analyze(".next/static/chunks/3u12sj69_m676.js");
analyze(".next/static/chunks/123jwzn4ybini.js");

// Is jsqr in node_modules size
const jsqr = fs.readFileSync("node_modules/jsqr/dist/jsQR.js", "utf8");
console.log("\njsqr dist size", jsqr.length);
// Search all chunks for distinctive jsqr content
const marker = "jsQR is not defined"; // not sure
// use a unique string from jsqr
const unique = "version_to_size"; // common in jsqr
console.log("jsqr has version_to_size", jsqr.includes("version_to_size") || /VERSION/.test(jsqr.slice(0,2000)));
// grab a unique longer string from jsqr
const pick = jsqr.match(/[A-Za-z]{12,}/g)?.filter(s => s.length > 15).slice(0,20);
console.log("long tokens sample", pick?.slice(0,10));

// Better: take a 40-char unique snippet from middle of jsqr
const mid = jsqr.slice(Math.floor(jsqr.length/2), Math.floor(jsqr.length/2)+80);
console.log("mid snippet", JSON.stringify(mid.slice(0,60)));

const dir = ".next/static/chunks";
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".js")) continue;
  const t = fs.readFileSync(dir+"/"+f, "utf8");
  // jsqr has this distinctive
  if (t.includes("A---") && t.includes("jsQR") && t.length > 40000) {
    console.log("large jsqr-like", f, t.length);
  }
  if (t.includes("locate") && t.includes("extract") && t.includes("jsQR")) {
    console.log("locate+extract+jsQR", f, t.length);
  }
  // Search for bundled module name
  if (/"jsqr"|'jsqr'|jsqr\/dist|node_modules\/jsqr/.test(t)) {
    console.log("module path jsqr", f, t.length);
  }
}
