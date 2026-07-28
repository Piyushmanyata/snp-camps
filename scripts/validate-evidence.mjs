#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

export function computeSha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function computeManifestPayloadSha256(manifest) {
  const payload = structuredClone(manifest);
  if (payload.artifacts) {
    delete payload.artifacts.manifest_payload_sha256;
  }
  return computeSha256(JSON.stringify(payload, null, 2));
}

export function detectUnredactedSecrets(text) {
  const leaks = [];
  
  if (/postgres(?:ql)?:\/\/[^\s:@]+:[^\s:@]+@/i.test(text)) {
    leaks.push("Unredacted postgres connection credentials");
  }
  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(text)) {
    leaks.push("Unredacted JWT token");
  }
  if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(text)) {
    leaks.push("Unredacted Supabase secret key");
  }
  if (/sbp_[A-Za-z0-9_-]{10,}/.test(text)) {
    leaks.push("Unredacted Supabase token");
  }
  // Check for 12-digit Aadhaar patterns that aren't redacted
  if (/\b\d{4}\s\d{4}\s\d{4}\b/.test(text) || /\b\d{12}\b/.test(text)) {
    // Exclude common 12-digit non-Aadhaar strings if any, but flag potential PHI
    if (!text.includes("AADHAAR:***")) {
      leaks.push("Potential unredacted 12-digit Aadhaar number");
    }
  }

  return leaks;
}

export function detectEllipsesOrTruncation(text) {
  const suspicious = [];
  if (/^\s*\.\.\.\s*$/m.test(text) || /^\s*…\s*$/m.test(text)) {
    suspicious.push("Log output contains bare ellipsis lines indicating handwritten omission");
  }
  if (/\[handwritten summary\]/i.test(text) || /\[output omitted\]/i.test(text)) {
    suspicious.push("Log output contains explicit handwritten omission markers");
  }
  return suspicious;
}

export const REQUIRED_STAGES = [
  "lint",
  "unit",
  "type_build",
  "budgets",
  "db",
  "e2e",
  "accessibility",
  "migration",
  "env_security"
];

export function validateManifest(manifest, evidenceDir, options = {}) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["Invalid or missing manifest JSON object"], warnings };
  }

  // 1. Core Metadata
  if (!manifest.commit_sha || manifest.commit_sha === "unknown") {
    errors.push("Manifest missing valid commit_sha");
  }

  if (manifest.dirty && !options.allowDirty) {
    errors.push("Repository state was dirty during evidence capture; dirty runs require explicit waiver flag");
  }

  if (!manifest.timestamp || isNaN(Date.parse(manifest.timestamp))) {
    errors.push("Manifest missing valid ISO timestamp");
  }

  if (!manifest.tool_versions || !manifest.tool_versions.node) {
    errors.push("Manifest missing tool_versions metadata");
  }
  if (manifest.overall_status !== "PASS") {
    errors.push(`Manifest overall_status must be PASS, got '${manifest.overall_status}'`);
  }
  const expectedManifestHash = manifest.artifacts?.manifest_payload_sha256;
  if (!expectedManifestHash) {
    errors.push("Manifest missing artifacts.manifest_payload_sha256");
  } else {
    const actualManifestHash = computeManifestPayloadSha256(manifest);
    if (expectedManifestHash !== actualManifestHash) {
      errors.push(
        `Manifest payload sha256 mismatch! Expected: ${expectedManifestHash}, Actual: ${actualManifestHash}`,
      );
    }
  }

  // 2. Stage Coverage
  const stages = manifest.stages || {};
  for (const reqStage of REQUIRED_STAGES) {
    if (!stages[reqStage]) {
      if (options.allowSkips && options.allowedSkips?.includes(reqStage)) {
        warnings.push(`Required stage '${reqStage}' was skipped under explicit waiver`);
      } else {
        errors.push(`Missing required evidence stage: '${reqStage}'`);
      }
    }
  }

  // 3. Stage Integrity & Log Artifacts
  for (const [stageName, stageData] of Object.entries(stages)) {
    if (stageData.exit_code !== 0 || stageData.status !== "PASS") {
      errors.push(
        `Stage '${stageName}' is not a clean PASS (status=${stageData.status}, exit=${stageData.exit_code})`,
      );
    }

    if (!stageData.log_file) {
      errors.push(`Stage '${stageName}' missing log_file reference`);
      continue;
    }

    const logPath = path.join(evidenceDir, stageData.log_file);
    if (!fs.existsSync(logPath)) {
      errors.push(`Stage '${stageName}' log file missing on disk: ${logPath}`);
      continue;
    }

    const logContent = fs.readFileSync(logPath, "utf8");
    const actualSha = computeSha256(logContent);

    if (stageData.sha256 && stageData.sha256 !== actualSha) {
      errors.push(`Stage '${stageName}' sha256 mismatch! Expected: ${stageData.sha256}, Actual: ${actualSha}`);
    }

    // Check for unredacted secrets
    const leaks = detectUnredactedSecrets(logContent);
    if (leaks.length > 0) {
      errors.push(`Stage '${stageName}' log file contains unredacted secrets: ${leaks.join(", ")}`);
    }

    // Check for handwritten ellipsis truncation
    const truncationIssues = detectEllipsesOrTruncation(logContent);
    if (truncationIssues.length > 0) {
      errors.push(`Stage '${stageName}' log file failed truncation check: ${truncationIssues.join(", ")}`);
    }

    // Check counts
    if (!stageData.counts || typeof stageData.counts !== "object") {
      errors.push(`Stage '${stageName}' missing structured item counts`);
    } else {
      if (Number(stageData.counts.failed ?? 0) > 0) {
        errors.push(`Stage '${stageName}' reported ${stageData.counts.failed} failed item(s)`);
      }
      if (Number(stageData.counts.skipped ?? 0) > 0 && !options.allowSkippedTests) {
        errors.push(`Stage '${stageName}' reported ${stageData.counts.skipped} skipped test(s)`);
      }
      if (Number(stageData.counts.todo ?? 0) > 0) {
        errors.push(`Stage '${stageName}' reported ${stageData.counts.todo} todo item(s)`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function validateClosureDocument(docContent) {
  const errors = [];
  
  const requiredSections = [
    { title: "Criterion-to-Evidence Mapping", regex: /##?\s*Criterion-to-Evidence/i },
    { title: "Red/Green Reproduction", regex: /##?\s*Red\/Green/i },
    { title: "Browser & Database Verification", regex: /##?\s*Browser.*Database/i },
    { title: "Explicit Skips, Blocks, Waivers", regex: /##?\s*Explicit Skips|Waivers/i },
    { title: "Rollback Procedure", regex: /##?\s*Rollback/i },
    { title: "Risk Analysis", regex: /##?\s*Risk Analysis/i },
  ];

  for (const sec of requiredSections) {
    if (!sec.regex.test(docContent)) {
      errors.push(`Closure document missing required section: '${sec.title}'`);
    }
  }

  if (detectEllipsesOrTruncation(docContent).length > 0) {
    errors.push("Closure document contains unverified handwritten ellipsis truncation");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export async function main() {
  const args = process.argv.slice(2);
  const evidenceDir = args.find((a) => !a.startsWith("--")) || path.join(root, "docs", "evidence");
  const manifestPath = path.join(evidenceDir, "evidence-manifest.json");

  if (!fs.existsSync(manifestPath)) {
    console.error(`[VALIDATOR] Error: Manifest file not found at ${manifestPath}`);
    process.exit(1);
  }

  console.log(`[VALIDATOR] Validating evidence manifest at: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  
  const allowDirty = args.includes("--allow-dirty") || args.includes("--dirty");
  const result = validateManifest(manifest, evidenceDir, { allowDirty });

  if (result.warnings.length > 0) {
    console.warn(`[VALIDATOR] Warnings:\n${result.warnings.map((w) => `  - ${w}`).join("\n")}`);
  }

  if (!result.valid) {
    console.error(`[VALIDATOR] Validation FAILED:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }

  console.log("[VALIDATOR] Evidence manifest validation PASSED clean!");

  // Validate closure report if exists
  const reportPath = path.join(evidenceDir, "evidence-report.md");
  if (!fs.existsSync(reportPath)) {
    console.error(`[VALIDATOR] Closure report missing: ${reportPath}`);
    process.exit(1);
  }
  const reportContent = fs.readFileSync(reportPath, "utf8");
  const docResult = validateClosureDocument(reportContent);
  if (!docResult.valid) {
    console.error(`[VALIDATOR] Closure report validation FAILED:\n${docResult.errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log("[VALIDATOR] Closure report structure verified!");

  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("[VALIDATOR] Unexpected validator error:", err);
    process.exit(1);
  });
}
