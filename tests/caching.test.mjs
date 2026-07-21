import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

test("Static Query Caching Verification (R3): src/lib/metadata.ts", () => {
  const filePath = path.join(process.cwd(), "src/lib/metadata.ts");
  const content = fs.readFileSync(filePath, "utf-8");

  // Check 1: React cache import
  assert.ok(
    content.includes('import { cache } from "react";'),
    "metadata.ts must import React.cache"
  );

  // Check 2: Next.js unstable_cache import
  assert.ok(
    content.includes('import { unstable_cache } from "next/cache.js";') ||
      content.includes('import { unstable_cache } from "next/cache";'),
    "metadata.ts must import Next.js unstable_cache"
  );

  // Check 3: getCampsList uses unstable_cache and cache
  assert.ok(
    content.includes('unstable_cache(\n  fetchCachedCampsList') ||
      content.includes('unstable_cache(') && content.includes('camps-list-metadata-v1'),
    "fetchCachedCampsList must be wrapped with unstable_cache"
  );
  assert.ok(
    content.includes("export const getCampsList = cache("),
    "getCampsList must be exported and wrapped with React.cache()"
  );

  // Check 4: getDoctorsList uses unstable_cache and cache
  assert.ok(
    content.includes('doctors-list-metadata-v1') && content.includes('tags: ["doctors-list"]'),
    "fetchCachedDoctorsList must be wrapped with unstable_cache and tag 'doctors-list'"
  );
  assert.ok(
    content.includes("export const getDoctorsList = cache("),
    "getDoctorsList must be exported and wrapped with React.cache()"
  );

  // Check 5: Revalidation parameters check
  assert.ok(
    content.includes("revalidate: 60"),
    "unstable_cache must configure revalidate: 60"
  );

  console.log("[CACHING VERIFICATION] React.cache() and unstable_cache() verified in src/lib/metadata.ts!");
});
