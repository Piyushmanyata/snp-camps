import fs from "fs";

// Find module 19994 registration across chunks
const dir = ".next/static/chunks";
for (const f of fs.readdirSync(dir).filter(x=>x.endsWith(".js"))) {
  const t = fs.readFileSync(dir+"/"+f, "utf8");
  // turbopack module registration patterns
  const patterns = [
    /19994/,
    /"19994"/,
    /\[19994\]/,
  ];
  if (t.includes("19994")) {
    const count = (t.match(/19994/g)||[]).length;
    console.log("has 19994:", f, "size", t.length, "count", count);
    // context
    let idx = 0, n=0;
    while ((idx = t.indexOf("19994", idx)) !== -1 && n < 2) {
      console.log("  ctx:", JSON.stringify(t.slice(Math.max(0,idx-50), idx+80)));
      idx += 5; n++;
    }
  }
  // also coefficientsLength from jsqr
  if (t.includes("coefficientsLength")) {
    console.log("coefficientsLength in", f, t.length);
  }
  if (t.includes("0x9C52")) {
    console.log("0x9C52 in", f, t.length);
  }
}

// Look at turbopack runtime for how e.A works
const runtime = fs.readFileSync(dir+"/turbopack-33ttaqp7yv_5q.js","utf8");
console.log("\nturbopack runtime size", runtime.length);
// search for async load
for (const key of [".A=", "async", "loadChunk", "CHUNK", "chunks"]) {
  // skip
}
// Find function A definition patterns
const m = runtime.match(/.{0,30}\.A\s*=\s*.{0,120}/);
console.log("A assign", m?.[0]);
const m2 = runtime.match(/function [A-Za-z$]+\([^)]*\)\{[^}]{0,200}chunks/);
console.log("fn chunks", m2?.[0]?.slice(0,200));

// Other main files
for (const f of ["3hdj40qmts5sf.js","3ze9nkq3ic5bd.js","21u51kcu-3-i8.js","33k5acykajrdr.js"]) {
  const t = fs.readFileSync(dir+"/"+f,"utf8");
  if (t.includes("coefficientsLength") || t.includes("0x9C52") || t.includes("function jsQR")) {
    console.log("JSQR IN MAIN", f);
  }
  // module map for 19994
  if (t.includes("19994")) console.log("19994 in main", f, (t.match(/19994/g)||[]).length);
}
