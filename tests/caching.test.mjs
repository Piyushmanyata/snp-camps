import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

test("metadata caching is scoped to its consistency requirements", () => {
  const content = fs.readFileSync(
    path.join(process.cwd(), "src/lib/metadata.ts"),
    "utf-8",
  );
  const campsBlock = content.slice(
    content.indexOf("export const getCampsList"),
    content.indexOf("async function fetchCachedDoctorsList"),
  );
  const doctorsBlock = content.slice(
    content.indexOf("async function fetchCachedDoctorsList"),
  );

  assert.match(content, /import \{ unstable_cache \} from "next\/cache";/);
  assert.doesNotMatch(content, /next\/cache\.js/);
  assert.match(campsBlock, /export const getCampsList = cache\(/);
  assert.match(campsBlock, /await createClient\(\)/);
  assert.doesNotMatch(campsBlock, /unstable_cache|createServiceRoleClient/);
  assert.match(doctorsBlock, /doctors-list-metadata-v1/);
  assert.match(doctorsBlock, /revalidate: 60, tags: \["doctors-list"\]/);
  assert.match(doctorsBlock, /export const getDoctorsList = cache\(/);
  assert.match(doctorsBlock, /if \(error\) throw new Error/);
});

test("public active camp snapshot has a short tagged cache", () => {
  const content = fs.readFileSync(
    path.join(process.cwd(), "src/lib/camp.ts"),
    "utf-8",
  );

  assert.match(content, /import \{ unstable_cache \} from "next\/cache";/);
  assert.match(content, /active-camp-snapshot-v1/);
  assert.match(
    content,
    /revalidate: 5, tags: \["active-camp-snapshot"\]/,
  );
  assert.match(content, /export const getActiveCampSnapshot = cache\(/);
  assert.match(content, /if \(error\) throw new Error/);
});
