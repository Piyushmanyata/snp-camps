import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  redactSecretsAndPhi,
  parseCounts,
  computeSha256,
} from "../scripts/capture-evidence.mjs";

import {
  validateManifest,
  validateClosureDocument,
  computeManifestPayloadSha256,
  detectUnredactedSecrets,
} from "../scripts/validate-evidence.mjs";

const tempDirBase = path.join(os.tmpdir(), "snp-evidence-tests");

describe("Evidence Capture & Validator Tooling (#74)", () => {
  test("redactSecretsAndPhi redacts JWT, Supabase keys, DB passwords, and Aadhaar", () => {
    const raw = `
      DATABASE_URL="postgres://user:supersecret123@localhost:5432/db"
      JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
      SUPABASE_KEY="sb_secret_998877665544332211"
      AADHAAR="1234 5678 9012"
      AUTHORIZATION="Bearer my_secret_bearer_token_123"
      AADHAAR_HASH_PEPPER="pepper-with-arbitrary-shape"
      MSG91_AUTH_KEY=provider-key-value
      ADMIN_INVITE_CODE=invite-me
    `;

    const redacted = redactSecretsAndPhi(raw);

    assert.ok(!redacted.includes("supersecret123"), "DB password must be redacted");
    assert.ok(!redacted.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "JWT must be redacted");
    assert.ok(!redacted.includes("sb_secret_998877665544332211"), "Supabase secret key must be redacted");
    assert.ok(!redacted.includes("1234 5678 9012"), "Aadhaar number must be redacted");
    assert.ok(!redacted.includes("pepper-with-arbitrary-shape"));
    assert.ok(!redacted.includes("provider-key-value"));
    assert.ok(!redacted.includes("invite-me"));
    assert.ok(redacted.includes("postgres://***"), "Redacted DB URL present");
    assert.ok(redacted.includes("jwt:***"), "Redacted JWT token present");
    assert.ok(
      redacted.includes("SUPABASE_KEY=***"),
      "Supabase key assignment is redacted",
    );
    assert.ok(redacted.includes("AADHAAR:***"), "Redacted Aadhaar present");
  });

  test("parseCounts extracts node --test, DB, and Playwright metrics", () => {
    const nodeTestOutput = `
      ℹ tests 101
      ℹ pass 100
      ℹ fail 0
      ℹ skipped 1
      ℹ todo 0
    `;
    const nodeCounts = parseCounts(nodeTestOutput);
    assert.equal(nodeCounts.total, 101);
    assert.equal(nodeCounts.passed, 100);
    assert.equal(nodeCounts.skipped, 1);

    const dbOutput = "DB TEST SUMMARY: tests=13 pass=13 fail=0 skipped=0 todo=0";
    const dbCounts = parseCounts(dbOutput);
    assert.equal(dbCounts.total, 13);
    assert.equal(dbCounts.passed, 13);
    assert.equal(dbCounts.failed, 0);

    const pwOutput = "10 passed, 1 skipped (12.4s)";
    const pwCounts = parseCounts(pwOutput);
    assert.equal(pwCounts.passed, 10);
    assert.equal(pwCounts.skipped, 1);
  });

  test("validateManifest rejects missing required stages", () => {
    const incompleteManifest = {
      schema_version: "1.0.0",
      ticket_id: "74",
      commit_sha: "abc12345",
      dirty: false,
      timestamp: new Date().toISOString(),
      tool_versions: { node: "v22.0.0" },
      stages: {
        lint: { status: "PASS", exit_code: 0, log_file: "logs/lint.log", sha256: "123", counts: { passed: 1 } },
      },
    };

    const result = validateManifest(incompleteManifest, tempDirBase);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("Missing required evidence stage")), "Must flag missing required stage");
  });

  test("validateManifest rejects non-zero exit codes", () => {
    const mockDir = path.join(tempDirBase, "fail-exit-test");
    fs.mkdirSync(path.join(mockDir, "logs"), { recursive: true });
    
    const logContent = "Error: Build failed with syntax error";
    const logSha = computeSha256(logContent);
    fs.writeFileSync(path.join(mockDir, "logs", "unit.log"), logContent, "utf8");

    const failedManifest = {
      schema_version: "1.0.0",
      ticket_id: "74",
      commit_sha: "abc12345",
      dirty: false,
      timestamp: new Date().toISOString(),
      tool_versions: { node: "v22.0.0" },
      stages: {
        lint: { status: "PASS", exit_code: 0, log_file: "logs/unit.log", sha256: logSha, counts: {} },
        unit: { status: "FAIL", exit_code: 1, log_file: "logs/unit.log", sha256: logSha, counts: {} },
        type_build: { status: "PASS", exit_code: 0, log_file: "logs/unit.log", sha256: logSha, counts: {} },
        budgets: { status: "PASS", exit_code: 0, log_file: "logs/unit.log", sha256: logSha, counts: {} },
        db: { status: "PASS", exit_code: 0, log_file: "logs/unit.log", sha256: logSha, counts: {} },
        e2e: { status: "PASS", exit_code: 0, log_file: "logs/unit.log", sha256: logSha, counts: {} },
        accessibility: { status: "PASS", exit_code: 0, log_file: "logs/unit.log", sha256: logSha, counts: {} },
        migration: { status: "PASS", exit_code: 0, log_file: "logs/unit.log", sha256: logSha, counts: {} },
        env_security: { status: "PASS", exit_code: 0, log_file: "logs/unit.log", sha256: logSha, counts: {} },
      },
    };

    const result = validateManifest(failedManifest, mockDir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("not a clean PASS")), "Must reject non-zero exit code stage");

    failedManifest.stages.unit.status = "PASS";
    const falseGreen = validateManifest(failedManifest, mockDir);
    assert.ok(
      falseGreen.errors.some((e) => e.includes("status=PASS, exit=1")),
      "A PASS label must never hide a nonzero exit",
    );
  });

  test("detectUnredactedSecrets catches generic key, token, pepper, and invite assignments", () => {
    const leaks = detectUnredactedSecrets(`
      AADHAAR_HASH_PEPPER=plain-value
      MSG91_AUTH_KEY="provider-value"
      ADMIN_INVITE_CODE: invite-value
      ANY_API_TOKEN=token-value
    `);
    assert.ok(
      leaks.includes("Unredacted secret environment assignment"),
      "arbitrary secret assignment values must be rejected",
    );
    assert.deepEqual(
      detectUnredactedSecrets(
        "AADHAAR_HASH_PEPPER=***\nMSG91_AUTH_KEY=***",
      ),
      [],
    );
  });

  test("manifest payload hash is stable only when the hash field is excluded", () => {
    const manifest = {
      overall_status: "PASS",
      artifacts: {},
      stages: {},
    };
    const hash = computeManifestPayloadSha256(manifest);
    manifest.artifacts.manifest_payload_sha256 = hash;
    assert.equal(computeManifestPayloadSha256(manifest), hash);
    manifest.overall_status = "FAIL";
    assert.notEqual(computeManifestPayloadSha256(manifest), hash);
  });

  test("validateManifest detects SHA256 tamper/mismatch", () => {
    const mockDir = path.join(tempDirBase, "sha-tamper-test");
    fs.mkdirSync(path.join(mockDir, "logs"), { recursive: true });

    const realContent = "Original clean log file";
    fs.writeFileSync(path.join(mockDir, "logs", "lint.log"), realContent, "utf8");

    const tamperedManifest = {
      schema_version: "1.0.0",
      ticket_id: "74",
      commit_sha: "abc12345",
      dirty: false,
      timestamp: new Date().toISOString(),
      tool_versions: { node: "v22.0.0" },
      stages: {
        lint: { status: "PASS", exit_code: 0, log_file: "logs/lint.log", sha256: "fake_wrong_sha256", counts: {} },
      },
    };

    const result = validateManifest(tamperedManifest, mockDir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("sha256 mismatch")), "Must detect tampered sha256");
  });

  test("validateManifest rejects handwritten ellipses truncation", () => {
    const mockDir = path.join(tempDirBase, "ellipsis-test");
    fs.mkdirSync(path.join(mockDir, "logs"), { recursive: true });

    const truncatedLog = "Header line\n...\n[output omitted]\nFooter line";
    const sha = computeSha256(truncatedLog);
    fs.writeFileSync(path.join(mockDir, "logs", "unit.log"), truncatedLog, "utf8");

    const manifest = {
      schema_version: "1.0.0",
      ticket_id: "74",
      commit_sha: "abc12345",
      dirty: false,
      timestamp: new Date().toISOString(),
      tool_versions: { node: "v22.0.0" },
      stages: {
        unit: { status: "PASS", exit_code: 0, log_file: "logs/unit.log", sha256: sha, counts: {} },
      },
    };

    const result = validateManifest(manifest, mockDir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("failed truncation check")), "Must reject ellipsis truncation");
  });

  test("validateManifest flags unredacted secrets in log outputs", () => {
    const mockDir = path.join(tempDirBase, "secret-leak-test");
    fs.mkdirSync(path.join(mockDir, "logs"), { recursive: true });

    const leakyLog = "Connected to postgres://admin:secretPass123@db.example.com/db";
    const sha = computeSha256(leakyLog);
    fs.writeFileSync(path.join(mockDir, "logs", "env_security.log"), leakyLog, "utf8");

    const manifest = {
      schema_version: "1.0.0",
      ticket_id: "74",
      commit_sha: "abc12345",
      dirty: false,
      timestamp: new Date().toISOString(),
      tool_versions: { node: "v22.0.0" },
      stages: {
        env_security: { status: "PASS", exit_code: 0, log_file: "logs/env_security.log", sha256: sha, counts: {} },
      },
    };

    const result = validateManifest(manifest, mockDir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("unredacted secrets")), "Must flag unredacted secret leaks");
  });

  test("validateClosureDocument enforces required closure sections", () => {
    const incompleteDoc = "# Ticket Closure\n## Overview\nDone!";
    const result = validateClosureDocument(incompleteDoc);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 4, "Must enforce missing sections in closure report");
  });

  test("validateManifest requires every stage log to have a sha256", () => {
    const mockDir = path.join(tempDirBase, "sha-missing-test");
    fs.mkdirSync(path.join(mockDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(mockDir, "logs", "lint.log"), "lint passed", "utf8");
    const manifest = {
      schema_version: "1.0.0",
      ticket_id: "74",
      commit_sha: "abc12345",
      dirty: false,
      timestamp: new Date().toISOString(),
      tool_versions: { node: "v22.0.0" },
      stages: {
        lint: {
          status: "PASS",
          exit_code: 0,
          log_file: "logs/lint.log",
          counts: {},
        },
      },
    };
    const result = validateManifest(manifest, mockDir);
    assert.ok(result.errors.some((error) => error.includes("missing sha256")));
  });

  test("red/green artifacts require an EOF marker matching the manifest", () => {
    const mockDir = path.join(tempDirBase, "red-green-marker-test");
    fs.mkdirSync(path.join(mockDir, "logs"), { recursive: true });
    const red = "real failing command output with details\nEVIDENCE_EXIT_CODE=1\nappended";
    const green = "real passing command output with details\nEVIDENCE_EXIT_CODE=0\n";
    fs.writeFileSync(path.join(mockDir, "logs", "red.log"), red);
    fs.writeFileSync(path.join(mockDir, "logs", "green.log"), green);
    const manifest = {
      schema_version: "1.0.0",
      ticket_id: "74",
      commit_sha: "abc12345",
      dirty: false,
      timestamp: new Date().toISOString(),
      tool_versions: { node: "v22.0.0" },
      overall_status: "PASS",
      stages: {},
      artifacts: {
        red_green: {
          red: {
            log_file: "logs/red.log",
            sha256: computeSha256(red),
            exit_code: 1,
          },
          green: {
            log_file: "logs/green.log",
            sha256: computeSha256(green),
            exit_code: 9,
          },
        },
      },
    };
    manifest.artifacts.manifest_payload_sha256 =
      computeManifestPayloadSha256(manifest);
    const result = validateManifest(manifest, mockDir);
    assert.ok(
      result.errors.some((error) => error.includes("must end")),
      "appended red output must fail",
    );
    assert.ok(
      result.errors.some((error) => error.includes("disagrees")),
      "green marker must match manifest",
    );
  });

  test("validateClosureDocument rejects a heading without literal red/green proof", () => {
    const hollow = `
## Criterion-to-Evidence Mapping
## Red/Green Reproduction
Regression tests cover this.
## Browser & Database Verification
## Explicit Skips, Blocks, Waivers
## Rollback Procedure
## Risk Analysis
`;
    const result = validateClosureDocument(hollow);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("red artifact")));
    assert.ok(result.errors.some((error) => error.includes("green artifact")));
  });

  test("validateClosureDocument accepts hashed red and green artifacts", () => {
    const hash = "a".repeat(64);
    const complete = `
## Criterion-to-Evidence Mapping
## Red/Green Reproduction
- Red artifact: \`logs/red.log\` (exit 1, sha256 \`${hash}\`)
- Green artifact: \`logs/green.log\` (exit 0, sha256 \`${hash}\`)
## Browser & Database Verification
## Explicit Skips, Blocks, Waivers
## Rollback Procedure
## Risk Analysis
`;
    assert.equal(validateClosureDocument(complete).valid, true);
  });
});
