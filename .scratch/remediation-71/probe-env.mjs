import fs from "node:fs";
import path from "node:path";

const content = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
for (const line of content.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq <= 0) continue;
  const k = t.slice(0, eq).trim();
  if (!/SUPABASE|SITE_URL|URL/i.test(k)) continue;
  let v = t.slice(eq + 1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (/KEY|SECRET|TOKEN|PASSWORD/i.test(k)) {
    console.log(`${k}=len:${v.length}`);
  } else {
    try {
      console.log(`${k}=${new URL(v).origin}`);
    } catch {
      console.log(`${k}=${v.slice(0, 80)}`);
    }
  }
}

// Find baked public URL in .next
const dir = path.join(process.cwd(), ".next", "static", "chunks");
if (fs.existsSync(dir)) {
  const hosts = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(/https?:\/\/[a-zA-Z0-9._:-]+/g)) {
      if (/supabase|54321|127\.0\.0\.1|localhost/.test(m[0])) hosts.add(m[0]);
    }
  }
  console.log("built-client-hosts", [...hosts]);
}
