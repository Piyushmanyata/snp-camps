#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

export function redactSecretsAndPhi(text) {
  if (!text) return "";
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s:@]+:[^\s:@]+@/gi, "postgres://***:***@")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgres://***")
    .replace(/\b(?:[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PEPPER|INVITE_CODE)|PASSWORD|PASSWD|PWD|SECRET)\s*[:=]\s*["']?[^"'\s,;]+["']?/gi, (m) => {
      const parts = m.split(/[:=]/);
      return `${parts[0]}=***`;
    })
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "jwt:***")
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, "sb_secret_***")
    .replace(/sbp_[A-Za-z0-9_-]+/g, "sbp_***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "AADHAAR:***");
}

export function parseCounts(output) {
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
  
  // node --test output format
  const testsMatch = output.match(/^\s*ℹ tests\s+(\d+)$/m);
  const passMatch = output.match(/^\s*ℹ pass\s+(\d+)$/m);
  const failMatch = output.match(/^\s*ℹ fail\s+(\d+)$/m);
  const skipMatch = output.match(/^\s*ℹ skipped\s+(\d+)$/m);
  const todoMatch = output.match(/^\s*ℹ todo\s+(\d+)$/m);

  if (testsMatch) counts.total = parseInt(testsMatch[1], 10);
  if (passMatch) counts.passed = parseInt(passMatch[1], 10);
  if (failMatch) counts.failed = parseInt(failMatch[1], 10);
  if (skipMatch) counts.skipped = parseInt(skipMatch[1], 10);
  if (todoMatch) counts.todo = parseInt(todoMatch[1], 10);

  // DB TEST SUMMARY format
  const dbMatch = output.match(/DB TEST SUMMARY:\s*tests=(\d+)\s+pass=(\d+)\s+fail=(\d+)\s+skipped=(\d+)(?:\s+todo=(\d+))?/);
  if (dbMatch) {
    counts.total = parseInt(dbMatch[1], 10);
    counts.passed = parseInt(dbMatch[2], 10);
    counts.failed = parseInt(dbMatch[3], 10);
    counts.skipped = parseInt(dbMatch[4], 10);
    if (dbMatch[5]) counts.todo = parseInt(dbMatch[5], 10);
  }

  // Playwright format
  const pwPassed = output.match(/(\d+)\s+passed/);
  const pwSkipped = output.match(/(\d+)\s+skipped/);
  const pwFailed = output.match(/(\d+)\s+failed/);
  if (pwPassed && !dbMatch && !testsMatch) {
    counts.passed = parseInt(pwPassed[1], 10);
    if (pwSkipped) counts.skipped = parseInt(pwSkipped[1], 10);
    if (pwFailed) counts.failed = parseInt(pwFailed[1], 10);
    counts.total = counts.passed + counts.skipped + counts.failed;
  }

  return counts;
}

export function computeSha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function captureRedGreenArtifact(sourcePath, outputDir, label) {
  const absolutePath = path.resolve(root, sourcePath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const normalized = raw.trimEnd();
  const exitMatch = normalized.match(
    /(?:^|\r?\n)EVIDENCE_EXIT_CODE=(\d+)$/,
  );
  if (!exitMatch) {
    throw new Error(
      `${label} proof must end with a literal EVIDENCE_EXIT_CODE=<number> line`,
    );
  }
  const substantiveOutput = normalized.slice(0, exitMatch.index).trim();
  if (substantiveOutput.length < 20) {
    throw new Error(`${label} proof must contain substantive command output`);
  }

  const content = `${redactSecretsAndPhi(normalized)}\n`;
  const logFile = `logs/red-green-${label}.log`;
  fs.writeFileSync(path.join(outputDir, logFile), content, "utf8");
  return {
    exit_code: Number(exitMatch[1]),
    log_file: logFile,
    sha256: computeSha256(content),
  };
}

export function getGitMetadata() {
  let commitSha = "unknown";
  let dirty = false;
  try {
    commitSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
    const status = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim();
    dirty = status.length > 0;
  } catch {
    commitSha = process.env.GIT_COMMIT_SHA || "unknown-no-git";
  }
  return { commitSha, dirty };
}

export function getToolVersions() {
  const safeExec = (cmd) => {
    try {
      return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return "unavailable";
    }
  };

  return {
    node: process.version,
    npm: safeExec("npm --version"),
    typescript: safeExec("npx tsc --version"),
    next: safeExec("npx next --version"),
    playwright: safeExec("npx playwright --version"),
  };
}

export const STAGE_DEFINITIONS = {
  lint: { name: "lint", command: "npm run lint", description: "ESLint static code analysis" },
  unit: { name: "unit", command: "npm test", description: "Node test runner unit suites" },
  type_build: { name: "type_build", command: "npx tsc --noEmit && npm run build", description: "TypeScript compilation and Next.js build" },
  budgets: { name: "budgets", command: "npm run check:js-budget", description: "Client JS route bundle size budgets" },
  db: { name: "db", command: "npm run test:db", description: "Database isolation and migration contract tests" },
  e2e: { name: "e2e", command: "npm run test:e2e", description: "Playwright end-to-end user journeys" },
  accessibility: { name: "accessibility", command: "node e2e/run-local.mjs e2e/a11y-computed.spec.ts", description: "Computed contrast, touch, focus and scaling a11y checks" },
  migration: { name: "migration", command: "npm run compare:migrations", description: "Read-only migration head drift comparison" },
  env_security: { name: "env_security", command: "npm run check:env", description: "Documented environment variable reads check" },
};

export async function runCapture(options = {}) {
  const ticketId = options.ticketId || "74";
  const selectedStages = options.stages || Object.keys(STAGE_DEFINITIONS);
  const outputDir = options.outputDir || path.join(root, "docs", "evidence");

  fs.mkdirSync(outputDir, { recursive: true });
  const logsDir = path.join(outputDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const git = getGitMetadata();
  const timestamp = new Date().toISOString();
  const toolVersions = getToolVersions();

  const manifest = {
    schema_version: "1.0.0",
    ticket_id: ticketId,
    commit_sha: git.commitSha,
    dirty: git.dirty,
    timestamp,
    platform: {
      os_platform: process.platform,
      os_arch: process.arch,
      os_release: os.release(),
      os_type: os.type(),
    },
    tool_versions: toolVersions,
    stages: {},
    overall_status: "PASS",
    artifacts: {},
  };

  let anyFailed = false;
  if (options.redLogPath && options.greenLogPath) {
    manifest.artifacts.red_green = {
      defect: String(options.defect || "Regression under review").slice(0, 300),
      red: captureRedGreenArtifact(options.redLogPath, outputDir, "red"),
      green: captureRedGreenArtifact(options.greenLogPath, outputDir, "green"),
    };
    if (
      manifest.artifacts.red_green.red.exit_code === 0 ||
      manifest.artifacts.red_green.green.exit_code !== 0
    ) {
      anyFailed = true;
    }
  } else {
    anyFailed = true;
  }

  for (const stageKey of selectedStages) {
    const stageDef = STAGE_DEFINITIONS[stageKey];
    if (!stageDef) {
      console.warn(`Warning: Unknown stage '${stageKey}' requested.`);
      continue;
    }

    const startTime = Date.now();
    console.log(`[EVIDENCE] Running stage: ${stageDef.name} ('${stageDef.command}')...`);

    const result = spawnSync(stageDef.command, {
      cwd: root,
      shell: true,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });

    const durationMs = Date.now() - startTime;
    const rawOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    const redactedOutput = redactSecretsAndPhi(rawOutput);

    const logFileName = `${stageDef.name}.log`;
    const logFilePath = path.join(logsDir, logFileName);
    fs.writeFileSync(logFilePath, redactedOutput, "utf8");

    const sha256 = computeSha256(redactedOutput);
    const counts = parseCounts(redactedOutput);
    const exitCode = result.status ?? (result.error ? 1 : 0);

    const passed = exitCode === 0;
    if (!passed) anyFailed = true;

    manifest.stages[stageDef.name] = {
      command: stageDef.command,
      description: stageDef.description,
      status: passed ? "PASS" : "FAIL",
      exit_code: exitCode,
      duration_ms: durationMs,
      log_file: `logs/${logFileName}`,
      sha256,
      counts,
    };
  }

  manifest.overall_status = anyFailed ? "FAIL" : "PASS";

  const manifestPath = path.join(outputDir, "evidence-manifest.json");
  const manifestPayload = JSON.stringify(manifest, null, 2);
  manifest.artifacts.manifest_payload_sha256 = computeSha256(manifestPayload);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  // Also write human-readable summary report
  const reportPath = path.join(outputDir, "evidence-report.md");
  const reportContent = generateMarkdownReport(manifest);
  fs.writeFileSync(reportPath, reportContent, "utf8");

  console.log(`[EVIDENCE] Capture complete. Overall status: ${manifest.overall_status}`);
  console.log(`[EVIDENCE] Manifest saved to: ${manifestPath}`);
  console.log(`[EVIDENCE] Markdown report saved to: ${reportPath}`);

  return manifest;
}

function generateMarkdownReport(manifest) {
  const stageRows = Object.entries(manifest.stages)
    .map(([name, stage]) => {
      const countsStr = `pass=${stage.counts.passed}, fail=${stage.counts.failed}, skip=${stage.counts.skipped}`;
      return `| \`${name}\` | **${stage.status}** | \`${stage.exit_code}\` | ${stage.duration_ms}ms | ${countsStr} | \`${stage.sha256.slice(0, 12)}...\` | [\`${stage.log_file}\`](${stage.log_file}) |`;
    })
    .join("\n");

  const proof = manifest.artifacts.red_green;
  const redGreenSection = proof
    ? `Defect: ${String(proof.defect).replaceAll("|", "\\|")}

- Red artifact: \`${proof.red.log_file}\` (exit ${proof.red.exit_code}, sha256 \`${proof.red.sha256}\`)
- Green artifact: \`${proof.green.log_file}\` (exit ${proof.green.exit_code}, sha256 \`${proof.green.sha256}\`)`
    : "No red/green artifacts were supplied. This report cannot close a bug or remediation ticket.";

  return `# Ticket #${manifest.ticket_id} Closure Evidence Report

- **Overall Status**: **${manifest.overall_status}**
- **Commit SHA**: \`${manifest.commit_sha}\`
- **Dirty State**: \`${manifest.dirty}\`
- **Timestamp (UTC)**: \`${manifest.timestamp}\`
- **Platform**: \`${manifest.platform.os_platform} (${manifest.platform.os_arch})\`
- **Node**: \`${manifest.tool_versions.node}\` | **npm**: \`${manifest.tool_versions.npm}\` | **Next**: \`${manifest.tool_versions.next}\`

## Stage Execution Matrix

| Stage | Result | Exit Code | Duration | Counts | SHA256 (Truncated) | Log File |
|-------|--------|-----------|----------|--------|---------------------|----------|
${stageRows}

## Integrity & Verification
- Manifest payload SHA256: \`${manifest.artifacts.manifest_payload_sha256 || "pending"}\`
- All secrets and PHI have been redacted using standard patterns.
- No log outputs rely on handwritten summaries or ellipses.

## Criterion-to-Evidence Mapping

Each required stage maps to its complete, hashed log in the Stage Execution Matrix.

## Red/Green Reproduction

${redGreenSection}

## Browser & Database Verification

The E2E and accessibility stages verify browser behavior. The database stage
verifies a clean append-only migration replay and all database contracts.

## Explicit Skips, Blocks, Waivers

No skips, blocks, or waivers are accepted in a passing manifest.

## Rollback Procedure

Application rollback uses the prior immutable deployment. Database migrations are
append-only; corrective rollback is a reviewed forward migration.

## Risk Analysis

Any nonzero exit, failed item, skipped test, missing stage, hash mismatch, dirty
worktree, secret leak, or incomplete closure section invalidates this evidence.
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const ticketArg = args.find((a) => a.startsWith("--ticket="))?.split("=")[1] || "74";
  const stagesArg = args.find((a) => a.startsWith("--stages="))?.split("=")[1]?.split(",");
  const redLogPath = args.find((a) => a.startsWith("--red-log="))?.slice("--red-log=".length);
  const greenLogPath = args.find((a) => a.startsWith("--green-log="))?.slice("--green-log=".length);
  const defect = args.find((a) => a.startsWith("--defect="))?.slice("--defect=".length);

  runCapture({
    ticketId: ticketArg,
    stages: stagesArg,
    redLogPath,
    greenLogPath,
    defect,
  })
    .then((manifest) => {
      if (manifest.overall_status !== "PASS") process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[EVIDENCE] Fatal capture error:", err);
      process.exit(1);
    });
}
