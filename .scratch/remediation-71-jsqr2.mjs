import fs from "fs";

const files = [
  "39fgiytt47ohq.js",
  "33k5acykajrdr.js",
  "37311a-an80s9.js",
  "36tt448q--qxs.js",
  "40alqurq0nwkt.js",
  "123jwzn4ybini.js",
  "3u12sj69_m676.js",
  "0cz1d0mv5g_q7.js",
];

// Distinctive jsqr content from the library
const jsqr = fs.readFileSync("node_modules/jsqr/dist/jsQR.js", "utf8");
// Find unique-ish constant arrays
const markers = [
  "coefficientsLength",
  "0x9C52",
  "webpackUniversalModuleDefinition",
  "getModuleExports",
  "function jsQR",
  "jsQR=",
  "exports.jsQR",
];

console.log("jsqr markers present in source:");
for (const m of markers) console.log(m, jsqr.includes(m));

for (const f of fs.readdirSync(".next/static/chunks").filter(x=>x.endsWith(".js"))) {
  const t = fs.readFileSync(".next/static/chunks/"+f, "utf8");
  const hits = markers.filter(m => t.includes(m));
  if (hits.length) console.log("HIT", f, t.length, hits.join(","));
}

// How does loadJsQr compile? Search for dynamic import module numbers
// Turbopack often uses something like i.A(moduleId) or similar
const scanner = fs.readFileSync(".next/static/chunks/123jwzn4ybini.js", "utf8");
// Find the loadJsQr equivalent - search "decoder could not load"
const idx = scanner.indexOf("QR decoder could not load");
console.log("\ndecoder error context:\n", scanner.slice(idx-400, idx+200));

// Also search Open camera area for import
const idx2 = scanner.indexOf("Opening camera");
console.log("\nopening camera context size around start fn - looking for async import patterns");
// Find all occurrences of .then( that look like module loads near jsqr load
