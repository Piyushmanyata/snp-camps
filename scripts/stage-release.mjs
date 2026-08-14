import { execSync } from "node:child_process";

function run(cmd) {
  console.log(`> ${cmd}`);
  const out = execSync(cmd, { encoding: "utf-8", stdio: "inherit" });
  return out;
}

try {
  console.log("=== SNP Camps Staged Atomic Git Release ===");

  // Commit 1: DB test harness zero-skip standardization
  console.log("\n--- Committing Milestone 1: DB Test Harness ---");
  run("git add tests/*.db.test.mjs tests/stubs/supabase-ssr.mjs tests/route-loader.mjs");
  run('git commit -m "test(db): enforce zero-skip reachability-only harness across all db suites"');

  // Commit 2: App Router resiliency, QR scan routing, and globals.css cleanup
  console.log("\n--- Committing Milestone 2: App Router Resiliency & CSS Cleanup ---");
  run("git add src/app/admin/clinical-operators/page.tsx src/app/volunteer/page.tsx src/app/team-lead/page.tsx src/app/p/[id]/page.tsx src/app/globals.css tests/issue-124-foundations.test.mjs tests/stubs/next-navigation.mjs");
  run('git commit -m "fix(app): add per-section error resiliency, correct admin qr scan routing, and clean legacy queue css"');

  // Commit 3: Code hardening and AGENTS.md §8 zero-comments rule enforcement
  console.log("\n--- Committing Milestone 3: Code Hardening & Zero-Comments Enforcement ---");
  run("git add src/components/ src/lib/ src/app/ src/proxy.ts");
  run('git commit -m "refactor(core): enforce AGENTS.md §8 zero-comments rule and harden component/lib modules"');

  // Commit 4: Empirical challenge test suites & project documentation
  console.log("\n--- Committing Milestone 4: Empirical Challenges & Project Docs ---");
  run("git add tests/adversarial-challenger-m4.test.mjs tests/empirical-challenge-m4-2.test.mjs PROJECT.md ORIGINAL_REQUEST.md scripts/stage-release.mjs scripts/stage-release.ps1");
  run('git commit -m "test(qa): add empirical challenge test suites and update project tracking documentation"');

  console.log("\n=== Git Log (Last 5 Commits) ===");
  run("git log -n 5 --oneline");

  console.log("\n=== Final Git Status ===");
  run("git status");

  console.log("\nRelease staging completed successfully!");
} catch (err) {
  console.error("Release staging failed:", err);
  process.exitCode = 1;
}
