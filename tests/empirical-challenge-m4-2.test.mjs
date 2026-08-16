/**
 * EMPIRICAL CHALLENGE M4-2: Security & Boundary Verification Suite.
 *
 * Authored by challenger_m4_2 (Security & Boundary Challenger).
 *
 * Adversarially stress tests:
 * 1. Route logic in src/app/p/[id]/page.tsx (malformed UUIDs, invalid roles, unauthenticated visits, case sensitivity, injection strings).
 * 2. Server Component error handling in:
 *    - src/app/admin/clinical-operators/page.tsx (simulated DB errors, non-admin redirects, empty states)
 *    - src/app/volunteer/page.tsx (admin view DB errors, volunteer view no-active-camp, team-lead roster failures)
 *    - src/app/team-lead/page.tsx (team_lead redirect to /volunteer, admin view DB errors, assignments query errors)
 * 3. Security boundaries, error leakage sanitization, and regression immunity.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isPatientUuid, parsePatientIdFromQr } from "../src/lib/qr.ts";
import {
  isStaff,
  isAdmin,
  isTeamLead,
  isClinicalOperator,
  isCampCrew,
  roleHome,
} from "../src/lib/roles.ts";
import { mapDbError } from "../src/lib/public-error.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const VALID_UUID = "a0b1c2d3-e4f5-4678-9abc-def012345678";

describe("EMPIRICAL CHALLENGE M4-2: Security & Boundary Verification", () => {
  // ==========================================================================
  // SECTION 1: ROUTE LOGIC IN /p/[id] (PatientScanPage)
  // ==========================================================================
  describe("1. Route Logic & Boundary Defense in /p/[id]", () => {
    test("Adversarial inputs: isPatientUuid rejects all malformed, injection, and boundary-violating inputs", () => {
      const maliciousAndMalformed = [
        "",
        "   ",
        null,
        undefined,
        12345,
        {},
        [],
        "not-a-uuid",
        "123",
        "a0b1c2d3-e4f5-4678-9abc",
        "a0b1c2d3-e4f5-4678-9abc-def012345678-extra",
        "g0b1c2d3-e4f5-4678-9abc-def012345678", // 'g' is non-hex
        "z0b1c2d3-e4f5-4678-9abc-def012345678",
        "<script>alert(1)</script>",
        "'; DROP TABLE patients; --",
        "../../admin",
        "https://evil.com/phishing",
        "a0b1c2d3_e4f5_4678_9abc_def012345678", // underscores instead of hyphens
        "a0b1c2d3-e4f5-4678-9abc-def01234567", // 35 chars
        "a0b1c2d3-e4f5-4678-9abc-def0123456789", // 37 chars
        "a0b1c2d3-e4f5-4678-9abc-def012345678\0", // null byte
        "a".repeat(600), // oversized input
      ];

      for (const input of maliciousAndMalformed) {
        assert.equal(
          isPatientUuid(input),
          false,
          `Expected input ${JSON.stringify(input)} to be rejected by isPatientUuid`,
        );
      }
    });

    test("UUID normalization: valid UUID variations correctly pass validation", () => {
      assert.equal(isPatientUuid(VALID_UUID), true);
      assert.equal(isPatientUuid(VALID_UUID.toUpperCase()), true);
      assert.equal(isPatientUuid(`  ${VALID_UUID}  `), true);
      assert.equal(isPatientUuid("00000000-0000-0000-0000-000000000000"), true);
      assert.equal(isPatientUuid("ffffffff-ffff-ffff-ffff-ffffffffffff"), true);
    });

    test("Role dispatch rules for QR scan: strictly mapped to role homes", () => {
      // 1. Clinical Operator -> /clinical
      assert.equal(isClinicalOperator("clinical_operator"), true);
      assert.equal(isCampCrew("clinical_operator"), false);
      assert.equal(roleHome("clinical_operator"), "/clinical");

      // 2. Admin -> /admin (Registration Desk context)
      assert.equal(isClinicalOperator("admin"), false);
      assert.equal(isCampCrew("admin"), true);
      assert.equal(isAdmin("admin"), true);
      assert.equal(roleHome("admin"), "/admin");

      // 3. Team Lead -> /volunteer
      assert.equal(isClinicalOperator("team_lead"), false);
      assert.equal(isCampCrew("team_lead"), true);
      assert.equal(isTeamLead("team_lead"), true);
      assert.equal(roleHome("team_lead"), "/volunteer");

      // 4. Volunteer -> /volunteer
      assert.equal(isClinicalOperator("volunteer"), false);
      assert.equal(isCampCrew("volunteer"), true);
      assert.equal(roleHome("volunteer"), "/volunteer");

      // 5. Retired / Unauthorized roles -> null
      assert.equal(isClinicalOperator("doctor"), false);
      assert.equal(isCampCrew("doctor"), false);
      assert.equal(roleHome("doctor"), null);

      assert.equal(isClinicalOperator("patient"), false);
      assert.equal(isCampCrew("patient"), false);
      assert.equal(roleHome("patient"), null);

      assert.equal(isClinicalOperator(null), false);
      assert.equal(isCampCrew(null), false);
      assert.equal(roleHome(null), null);
    });

    test("Source AST invariants in src/app/p/[id]/page.tsx", () => {
      const src = readSource("src/app/p/[id]/page.tsx");

      // 1. Awaits params Promise (Next.js 15/16 contract)
      assert.match(src, /const\s*\{\s*id:\s*rawId\s*\}\s*=\s*await\s*params;/);

      // 2. Trims and lowercases rawId
      assert.match(src, /const\s*id\s*=\s*rawId\.trim\(\)\.toLowerCase\(\);/);

      // 3. isPatientUuid check precedes all session lookup and redirects
      const uuidCheckIdx = src.indexOf("if (!isPatientUuid(id))");
      const sessionLookupIdx = src.indexOf("await getSessionProfile()");
      assert.ok(uuidCheckIdx !== -1, "Must contain !isPatientUuid check");
      assert.ok(sessionLookupIdx !== -1, "Must contain getSessionProfile call");
      assert.ok(
        uuidCheckIdx < sessionLookupIdx,
        "isPatientUuid validation must execute before session lookup",
      );

      // 4. Renders 'Invalid code' for invalid UUIDs
      assert.match(src, /<h1[^>]*>Invalid code<\/h1>/);
      assert.match(src, /Show this screen at the camp desk/);

      // 5. Clinical operator branches to /clinical?scan=${id}
      assert.match(src, /if\s*\(isClinicalOperator\(role\)\)\s*\{\s*redirect\(`\/clinical\?scan=\$\{id\}`\);\s*\}/);

      // 6. Non-camp crew renders 'Camp desk scan only'
      assert.match(src, /if\s*\(!isCampCrew\(role\)\)\s*\{/);
      assert.match(src, /<h1[^>]*>Camp desk scan only<\/h1>/);
      assert.match(src, /This QR is for camp staff\. Show it at the volunteer desk\./);

      // 7. Camp crew redirects to role desk base (e.g. /admin or /volunteer)
      assert.match(src, /const\s*deskBase\s*=\s*roleHome\(role\)\s*\|\|\s*["']\/volunteer["'];/);
      assert.match(src, /redirect\(`\$\{deskBase\}\?scan=\$\{id\}`\);/);
    });
  });

  // ==========================================================================
  // SECTION 2: SERVER COMPONENT ERROR RESILIENCY
  // ==========================================================================
  describe("2. Server Component Error Handling & Boundary Resilience", () => {
    // ------------------------------------------------------------------------
    // Page: Clinical Operators Page
    // ------------------------------------------------------------------------
    describe("ClinicalOperatorsPage (src/app/admin/clinical-operators/page.tsx)", () => {
      test("Source verification: Admin role check & redirect", () => {
        const src = readSource("src/app/admin/clinical-operators/page.tsx");
        assert.match(src, /const\s*\{\s*profile\s*\}\s*=\s*await\s*getSessionProfile\(\);/);
        assert.match(src, /if\s*\(profile\?\.role\s*!==\s*["']admin["']\)\s*\{\s*redirect\(roleHome\(profile\?\.role\)\s*\|\|\s*["']\/login["']\);\s*\}/);
      });

      test("Source verification: Database query error handling & fallback math", () => {
        const src = readSource("src/app/admin/clinical-operators/page.tsx");
        // Maps DB error without throwing
        assert.match(src, /let\s*loadError:\s*string\s*\|\s*null\s*=\s*null;/);
        assert.match(src, /if\s*\(error\)\s*\{\s*loadError\s*=\s*mapDbError\(error,\s*\{\s*context:\s*["']clinical-operators-page\.list["']/);
        assert.doesNotMatch(src, /if\s*\(error\)\s*\{\s*throw/);

        // Safe array filtering math that avoids null crashes
        assert.match(src, /const\s*active\s*=\s*operators\?\.filter\(\(operator\)\s*=>\s*!operator\.disabled_at\)\.length\s*\?\?\s*0;/);
        assert.match(src, /const\s*disabled\s*=\s*\(operators\?\.length\s*\?\?\s*0\)\s*-\s*active;/);

        // Renders ErrorBox conditionally
        assert.match(src, /\{loadError\s*\?\s*<ErrorBox\s*message=\{loadError\}\s*\/>\s*:\s*null\}/);

        // AdminStaff fallback array
        assert.match(src, /initial=\{operators\s*\|\|\s*\[\]\}/);
      });

      test("Logic simulation: operators list calculations with null/empty/active/disabled datasets", () => {
        // Case 1: Query failed (operators is null)
        const nullOperators = null;
        const active1 = nullOperators?.filter((op) => !op.disabled_at).length ?? 0;
        const disabled1 = (nullOperators?.length ?? 0) - active1;
        assert.equal(active1, 0);
        assert.equal(disabled1, 0);
        assert.deepEqual(nullOperators || [], []);

        // Case 2: Empty list (operators is [])
        const emptyOperators = [];
        const active2 = emptyOperators?.filter((op) => !op.disabled_at).length ?? 0;
        const disabled2 = (emptyOperators?.length ?? 0) - active2;
        assert.equal(active2, 0);
        assert.equal(disabled2, 0);

        // Case 3: Mixed dataset
        const mixedOperators = [
          { id: "1", disabled_at: null },
          { id: "2", disabled_at: null },
          { id: "3", disabled_at: "2026-08-01" },
        ];
        const active3 = mixedOperators.filter((op) => !op.disabled_at).length ?? 0;
        const disabled3 = (mixedOperators.length ?? 0) - active3;
        assert.equal(active3, 2);
        assert.equal(disabled3, 1);
      });
    });

    // ------------------------------------------------------------------------
    // Page: Volunteer Page
    // ------------------------------------------------------------------------
    describe("VolunteerPage (src/app/volunteer/page.tsx)", () => {
      test("Source verification: isStaff role gate", () => {
        const src = readSource("src/app/volunteer/page.tsx");
        assert.match(src, /if\s*\(!isStaff\(profile\?\.role\)\)\s*\{\s*redirect\(roleHome\(profile\?\.role\)\s*\|\|\s*["']\/login["']\);\s*\}/);
      });

      test("Source verification: Admin branch parallel queries and error resiliency", () => {
        const src = readSource("src/app/volunteer/page.tsx");
        assert.match(src, /Promise\.all\(\[\s*supabase\s*\.from\(["']profiles["']\)/);
        assert.match(src, /let\s*adminListError:\s*string\s*\|\s*null\s*=\s*null;/);
        assert.match(src, /if\s*\(error\s*\|\|\s*teamLeadsError\)\s*\{\s*adminListError\s*=\s*mapDbError\(error\s*\|\|\s*teamLeadsError/);
        assert.match(src, /\{adminListError\s*\?\s*<ErrorBox\s*message=\{adminListError\}\s*\/>\s*:\s*null\}/);
        assert.doesNotMatch(src, /if\s*\(error\s*\|\|\s*teamLeadsError\)\s*\{\s*throw/);
      });

      test("Source verification: Volunteer & Team Lead branch active-camp & roster error resiliency", () => {
        const src = readSource("src/app/volunteer/page.tsx");
        // Active camp query error handling
        assert.match(src, /let\s*campErrorMsg:\s*string\s*\|\s*null\s*=\s*null;/);
        assert.match(src, /if\s*\(campError\)\s*\{\s*campErrorMsg\s*=\s*mapDbError\(campError/);
        assert.match(src, /\{campErrorMsg\s*\?\s*<ErrorBox\s*message=\{campErrorMsg\}\s*\/>\s*:\s*null\}/);

        // Team Lead roster query error handling
        assert.match(src, /teamLead\s*&&\s*userId\s*\?/);
        assert.match(src, /if\s*\(rosterResult\.error\)\s*\{\s*mapDbError\(rosterResult\.error/);
        assert.match(src, /rosterError\s*=\s*["']Your team roster could not be loaded\. Refresh and try again\.["'];/);
        assert.match(src, /\{rosterError\s*\?\s*<ErrorBox\s*message=\{rosterError\}\s*\/>\s*:\s*null\}/);

        // Graceful empty/no-camp handling
        assert.match(src, /\{camp\?\.name\s*\|\|\s*["']Koi nahi["']\}/);
        assert.match(src, /disabled=\{!camp\}/);
        assert.match(src, /noCampReason=\s*\{\s*camp\s*\?\s*undefined\s*:\s*["']Koi active camp nahi\. Admin se camp chalu karwayein\.["']\s*\}/);
      });
    });

    // ------------------------------------------------------------------------
    // Page: Team Lead Page
    // ------------------------------------------------------------------------
    describe("TeamLeadPage (src/app/team-lead/page.tsx)", () => {
      test("Source verification: Team lead redirects to volunteer desk", () => {
        const src = readSource("src/app/team-lead/page.tsx");
        // Unauthenticated check
        assert.match(src, /if\s*\(!userId\)\s*redirect\(["']\/login["']\);/);
        // Non-lead / non-admin check
        assert.match(src, /if\s*\(!isTeamLead\(profile\?\.role\)\s*&&\s*!isAdmin\(profile\?\.role\)\)\s*\{\s*redirect\(roleHome\(profile\?\.role\)\s*\|\|\s*["']\/login["']\);\s*\}/);
        // Team Lead redirect to /volunteer (Domain rule)
        assert.match(src, /if\s*\(isTeamLead\(profile\?\.role\)\)\s*redirect\(["']\/volunteer["']\);/);
      });

      test("Source verification: Admin view query error handling & fallback components", () => {
        const src = readSource("src/app/team-lead/page.tsx");
        // Load error for team leads
        assert.match(src, /let\s*loadError:\s*string\s*\|\s*null\s*=\s*null;/);
        assert.match(src, /if\s*\(error\)\s*\{\s*loadError\s*=\s*mapDbError\(error/);
        assert.match(src, /\{loadError\s*\?\s*<ErrorBox\s*message=\{loadError\}\s*\/>\s*:\s*null\}/);

        // Assignments error for volunteers
        assert.match(src, /let\s*assignmentsError:\s*string\s*\|\s*null\s*=\s*null;/);
        assert.match(src, /if\s*\(volunteersError\)\s*\{\s*assignmentsError\s*=\s*mapDbError\(volunteersError/);
        assert.match(src, /\{assignmentsError\s*\?\s*<ErrorBox\s*message=\{assignmentsError\}\s*\/>\s*:\s*null\}/);

        // TeamAssignments fallback
        assert.match(src, /teamLeads=\{\(teamLeadsFull\s*\?\?\s*\[\]\)\.filter\(\(lead\)\s*=>\s*!lead\.disabled_at\)\}/);
        assert.match(src, /volunteers=\{volunteers\s*\?\?\s*\[\]\}/);
      });
    });
  });

  // ==========================================================================
  // SECTION 3: SECURITY BOUNDARIES & REGRESSION IMMUNITY
  // ==========================================================================
  describe("3. Security Boundaries & Zero-Leakage Invariants", () => {
    test("mapDbError sanitizes confidential SQL schema, RLS hints, and connection details", () => {
      const sensitiveErrors = [
        {
          err: {
            code: "42501",
            message: "permission denied for table internal_patients_secure_v2",
            details: "Failing row contains (super_secret_token_12345)",
            hint: "Check postgresql.conf superuser policy",
          },
          expected: "You do not have permission for this action.",
        },
        {
          err: {
            code: "23505",
            message: "duplicate key value violates unique constraint 'patients_aadhaar_hash_camp_id_uidx'",
          },
          expected: "That record already exists.",
        },
        {
          err: {
            code: "08006",
            message: "connection to server at 'prod-db.internal:5432' failed: Connection refused",
          },
          expected: "Something went wrong. Try again or ask the desk.",
        },
        {
          err: {
            code: "57014",
            message: "canceling statement due to statement timeout",
          },
          expected: "The request took too long. Try again.",
        },
        {
          err: {
            code: "40001",
            message: "could not serialize access due to concurrent update",
          },
          expected: "Something went wrong. Try again or ask the desk.",
        },
      ];

      for (const { err, expected } of sensitiveErrors) {
        const publicMessage = mapDbError(err, { context: "security-audit" });
        assert.equal(publicMessage, expected);
        assert.ok(!publicMessage.includes("internal_patients_secure_v2"));
        assert.ok(!publicMessage.includes("super_secret_token_12345"));
        assert.ok(!publicMessage.includes("prod-db.internal"));
        assert.ok(!publicMessage.includes("patients_aadhaar_hash_camp_id_uidx"));
      }
    });

    test("QR Parser enforces valid UUID boundaries across all supported input formats", () => {
      const valid = "a0b1c2d3-e4f5-4678-9abc-def012345678";
      assert.equal(parsePatientIdFromQr(valid), valid);
      assert.equal(parsePatientIdFromQr(`snp:${valid}`), valid);
      assert.equal(parsePatientIdFromQr(`https://camps.snp.org/p/${valid}`), valid);
      assert.equal(parsePatientIdFromQr(`https://camps.snp.org/print/${valid}`), valid);
      assert.equal(parsePatientIdFromQr(`https://camps.snp.org/patient/enter/${valid}`), valid);
      assert.equal(parsePatientIdFromQr(`https://camps.snp.org/scan?id=${valid}`), valid);
      assert.equal(parsePatientIdFromQr(`https://camps.snp.org/scan?scan=${valid}`), valid);

      // Malicious or invalid formats
      assert.equal(parsePatientIdFromQr("snp:not-a-uuid"), null);
      assert.equal(parsePatientIdFromQr("https://evil.com/p/12345"), null);
      assert.equal(parsePatientIdFromQr("<script>alert('xss')</script>"), null);
      assert.equal(parsePatientIdFromQr("a".repeat(1000)), null); // oversized string
    });

    test("No retired doctor/patient roles accepted in staff management or desk actions", () => {
      assert.equal(isStaff("doctor"), false);
      assert.equal(isStaff("patient"), false);
      assert.equal(isCampCrew("doctor"), false);
      assert.equal(isCampCrew("patient"), false);
      assert.equal(isAdmin("doctor"), false);
      assert.equal(isTeamLead("doctor"), false);
      assert.equal(isClinicalOperator("doctor"), false);
    });
  });
});
