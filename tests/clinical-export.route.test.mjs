import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../src/app/api/admin/exports/clinical.csv/route.ts";
import { __resetCookies, __setCookies } from "./stubs/next-headers.mjs";
import { __resetAuthMock, __setAuthMock } from "./stubs/supabase-ssr.mjs";
import {
  __resetServiceRoleClient,
  __setServiceRoleClient,
} from "./stubs/service-role-admin.mjs";
import {
  buildCampRecordsCsv,
  buildClinicalAuditCsv,
} from "../src/lib/clinical-export.ts";
import {
  encodeCsvCell,
  encodeCsvNumber,
  buildCsvDocument,
} from "../src/lib/clinical-csv.ts";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMP_ID = "22222222-2222-4222-8222-222222222222";

function signInAdmin() {
  __setCookies([{ name: "sb-test-auth-token", value: "1" }]);
  __setAuthMock({
    userId: ADMIN_ID,
    profile: {
      id: ADMIN_ID,
      role: "admin",
      full_name: "Admin",
      disabled_at: null,
    },
  });
}

function signInOperator() {
  __setCookies([{ name: "sb-test-auth-token", value: "1" }]);
  __setAuthMock({
    userId: ADMIN_ID,
    profile: {
      id: ADMIN_ID,
      role: "clinical_operator",
      full_name: "Operator",
      disabled_at: null,
    },
  });
}

function exportRequest(params = {}) {
  const url = new URL("http://localhost/api/admin/exports/clinical.csv");
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  return new Request(url, { method: "GET" });
}

function mockExportClient(handler) {
  __setServiceRoleClient({
    rpc: async (name, args) => handler(name, args),
  });
}

test.beforeEach(() => {
  __resetCookies();
  __resetAuthMock();
  __resetServiceRoleClient();
});

test("clinical CSV formula guard still neutralizes text cells", () => {
  assert.equal(encodeCsvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  assert.equal(encodeCsvCell("+1+1"), "\"'+1+1\"");
  assert.equal(encodeCsvCell("-2+3"), "\"'-2+3\"");
  assert.equal(encodeCsvCell("@SUM(A1:A2)"), "\"'@SUM(A1:A2)\"");
  assert.equal(encodeCsvCell("\t=1+1"), "\"'\t=1+1\"");
  assert.equal(encodeCsvCell("Normal name"), "\"Normal name\"");
});

test("numeric encoder emits bare signed spectacle powers", () => {
  assert.equal(encodeCsvNumber("-0.50"), "-0.50");
  assert.equal(encodeCsvNumber("+1.25"), encodeCsvCell("+1.25")); // + is formula prefix → text fallback only if not pure numeric; bare needs no +
  assert.equal(encodeCsvNumber("-2.00"), "-2.00");
  assert.equal(encodeCsvNumber("62"), "62");
  assert.equal(encodeCsvNumber("=1+1"), encodeCsvCell("=1+1"));
});

test("camp records CSV has BOM, CRLF, diagnosis columns, blank untranscribed row, Devanagari", () => {
  const csv = buildCampRecordsCsv(
    "Sikar Camp",
    ["REFRACTION", "CATARACT"],
    [
      {
        reg_no: 42,
        patient_name: "राम कुमार",
        age: 55,
        gender: "M",
        phone: "9876543210",
        address: "Ward 3",
        camp_name: "Sikar Camp",
        transcription_at: "2026-08-09T14:30:00.000Z",
        data: {
          diagnoses: { options: ["CATARACT"], other: "Other note" },
          bloodSugar: "120",
          bloodPressure: "120/80",
          remarks: "Line1\nLine2",
          medicines: "Drops",
          specs: {
            type: "distance",
            right: { sphere: "-0.50", cylinder: "-0.25", axis: "90", near: "1", vision: "6/6" },
            left: { sphere: "-1.00", cylinder: "0", axis: "80", near: "", vision: "" },
            pd: "62",
          },
          ot: { eye: "right", procedure: "Cataract", notes: "Bring reports" },
        },
        medicine_outcome: "not_available",
        specs_outcome: "deferred",
        ot_outcome: null,
        unavailable_medicines: ["Lubricant", "Antibiotic drops"],
      },
      {
        reg_no: 43,
        patient_name: "Seen Only",
        age: 40,
        gender: "F",
        phone: "9123456780",
        address: "Lane 2",
        camp_name: "Sikar Camp",
        transcription_at: null,
        data: null,
        medicine_outcome: null,
        specs_outcome: null,
        ot_outcome: null,
        unavailable_medicines: null,
      },
    ],
  );

  assert.equal(csv.charCodeAt(0), 0xfeff, "UTF-8 BOM");
  assert.match(csv, /\r\n/, "CRLF line endings");
  assert.match(csv, /diagnosis: REFRACTION/);
  assert.match(csv, /diagnosis: CATARACT/);
  assert.match(csv, /राम कुमार/);
  assert.match(csv, /,-0\.50,/);
  assert.match(csv, /household_phone/);
  assert.match(csv, /Lubricant; Antibiotic drops/);
  // Untranscribed patient appears with blank clinical columns (reg present)
  assert.match(csv, /(?:^|\r\n)43,/m);
  // Multi-line remarks survive inside quotes
  assert.match(csv, /Line1\nLine2/);
});

test("audit CSV is one row per event without patient name", () => {
  const csv = buildClinicalAuditCsv("Sikar Camp", [
    {
      reg_no: 42,
      entity: "fulfilment_item",
      event: "resolved",
      from_outcome: null,
      to_outcome: "not_available",
      reason: "Lubricant",
      actor_name: "Priya",
      created_at: "2026-08-09T14:30:00.000Z",
    },
  ]);
  assert.match(csv, /registration_number/);
  assert.match(csv, /Priya/);
  assert.doesNotMatch(csv, /patient_name/);
  assert.match(csv, /not_available/);
});

test("export route rejects non-admin", async () => {
  signInOperator();
  mockExportClient(async () => ({ data: null, error: null }));
  const response = await GET(exportRequest({ format: "records" }));
  assert.equal(response.status, 403);
});

test("export route errors when no camp is active", async () => {
  signInAdmin();
  mockExportClient(async (name) => {
    assert.equal(name, "admin_clinical_export");
    return { data: null, error: { message: "no camp selected or active" } };
  });
  const response = await GET(exportRequest({ format: "records" }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /Select a camp/i);
});

test("export route returns CSV attachment for records", async () => {
  signInAdmin();
  mockExportClient(async (_name, args) => {
    assert.equal(args.p_format, "records");
    assert.equal(args.p_camp_id, CAMP_ID);
    assert.equal(args.p_include_archived, false);
    return {
      data: {
        camp_id: CAMP_ID,
        camp_name: "Sikar Camp",
        diagnosis_options: ["REFRACTION"],
        rows: [
          {
            reg_no: 1,
            patient_name: "Test",
            age: 30,
            gender: "M",
            phone: "9876543210",
            address: "A",
            camp_name: "Sikar Camp",
            transcription_at: null,
            data: null,
            medicine_outcome: null,
            specs_outcome: null,
            ot_outcome: null,
            unavailable_medicines: null,
          },
        ],
      },
      error: null,
    };
  });
  const response = await GET(
    exportRequest({ format: "records", campId: CAMP_ID }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /camp-records-.*\.csv/,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  // UTF-8 BOM bytes (response.text() strips U+FEFF)
  assert.equal(bytes[0], 0xef);
  assert.equal(bytes[1], 0xbb);
  assert.equal(bytes[2], 0xbf);
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /Test/);
});

test("buildCsvDocument always uses CRLF and BOM", () => {
  const doc = buildCsvDocument([[encodeCsvCell("a"), encodeCsvCell("b")]]);
  assert.equal(doc.charCodeAt(0), 0xfeff);
  assert.ok(doc.includes("\r\n"));
});
