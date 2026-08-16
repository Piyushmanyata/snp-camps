import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SMS_VENUE_LENGTH,
  normalizeDateInput,
  normalizeVenueInput,
  validateVenueLength,
  getCampSettings,
  updateCampSettings,
} from "../src/lib/admin-settings.ts";

test("MAX_SMS_VENUE_LENGTH is 35 (reused SMS segment cap)", () => {
  assert.equal(MAX_SMS_VENUE_LENGTH, 35);
});

test("validateVenueLength: accepts strings <= 35 chars, rejects > 35 chars", () => {
  assert.equal(validateVenueLength(""), true, "empty string is valid");
  assert.equal(validateVenueLength(null), true, "null is valid");
  assert.equal(validateVenueLength("A".repeat(35)), true, "35 chars is valid");
  assert.equal(validateVenueLength("A".repeat(36)), false, "36 chars is invalid");
  assert.equal(validateVenueLength("Sikar Bhawan Hall 1"), true, "normal venue is valid");
});

test("normalizeVenueInput and normalizeDateInput: empty string becomes null (unset state)", () => {
  assert.equal(normalizeVenueInput(""), null, "empty venue is null");
  assert.equal(normalizeVenueInput("   "), null, "whitespace venue is null");
  assert.equal(normalizeVenueInput("Main Clinic"), "Main Clinic", "non-empty venue trimmed");
  assert.equal(normalizeDateInput(""), null, "empty date is null");
  assert.equal(normalizeDateInput("2026-10-15"), "2026-10-15", "valid date string returned");
});

test("updateCampSettings: throws error if spectacles venue exceeds max length", async () => {
  const longVenue = "A".repeat(36);
  await assert.rejects(
    async () => {
      await updateCampSettings("mock-camp-id", {
        spectaclesCollectionVenue: longVenue,
      });
    },
    /exceeds maximum allowed length of 35 characters/
  );
});

test("updateCampSettings: throws error if surgery venue exceeds max length", async () => {
  const longVenue = "B".repeat(40);
  await assert.rejects(
    async () => {
      await updateCampSettings("mock-camp-id", {
        postCampSurgeryVenue: longVenue,
      });
    },
    /exceeds maximum allowed length of 35 characters/
  );
});

test("updateCampSettings: an RPC refusal propagates and never falls back to a direct table write", async () => {
  let tableWrites = 0;
  const refusing = {
    rpc: async () => ({
      error: Object.assign(new Error("Spectacles collection venue exceeds maximum length of 35 characters"), {
        code: "22001",
      }),
    }),
    from: () => {
      tableWrites += 1;
      throw new Error("updateCampSettings bypassed the RPC refusal with a direct table write");
    },
  };

  await assert.rejects(
    () =>
      updateCampSettings(
        "camp-1",
        { spectaclesCollectionVenue: "Main Clinic" },
        refusing,
      ),
    /exceeds maximum length of 35 characters/,
  );
  assert.equal(tableWrites, 0, "the database refusal is final");
});

test("getCampSettings & updateCampSettings: mock client handles independent settings", async () => {
  let storedData = {
    spectacles_collection_date: null,
    spectacles_collection_venue: null,
    post_camp_surgery_date: null,
    post_camp_surgery_venue: null,
  };

  const mockClient = {
    rpc: async (fnName, params) => {
      if (fnName === "update_camp_settings") {
        storedData = {
          spectacles_collection_date: params.p_spectacles_collection_date,
          spectacles_collection_venue: params.p_spectacles_collection_venue,
          post_camp_surgery_date: params.p_post_camp_surgery_date,
          post_camp_surgery_venue: params.p_post_camp_surgery_venue,
        };
        return { error: null };
      }
      return { error: new Error("Unknown RPC") };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: storedData, error: null }),
        }),
      }),
    }),
  };

  // Initial unset state
  const initial = await getCampSettings("camp-1", mockClient);
  assert.deepEqual(initial, {
    spectaclesCollectionDate: null,
    spectaclesCollectionVenue: null,
    postCampSurgeryDate: null,
    postCampSurgeryVenue: null,
  });

  // Admin updates only spectacles collection pair
  await updateCampSettings(
    "camp-1",
    {
      spectaclesCollectionDate: "2026-10-20",
      spectaclesCollectionVenue: "Community Center",
    },
    mockClient
  );

  const afterSpecUpdate = await getCampSettings("camp-1", mockClient);
  assert.equal(afterSpecUpdate.spectaclesCollectionDate, "2026-10-20");
  assert.equal(afterSpecUpdate.spectaclesCollectionVenue, "Community Center");
  assert.equal(afterSpecUpdate.postCampSurgeryDate, null, "surgery date remains unset");
  assert.equal(afterSpecUpdate.postCampSurgeryVenue, null, "surgery venue remains unset");

  // Admin updates post-camp surgery pair independently
  await updateCampSettings(
    "camp-1",
    {
      spectaclesCollectionDate: "2026-10-20",
      spectaclesCollectionVenue: "Community Center",
      postCampSurgeryDate: "2026-11-05",
      postCampSurgeryVenue: "General Hospital",
    },
    mockClient
  );

  const afterSurgeryUpdate = await getCampSettings("camp-1", mockClient);
  assert.equal(afterSurgeryUpdate.spectaclesCollectionDate, "2026-10-20");
  assert.equal(afterSurgeryUpdate.spectaclesCollectionVenue, "Community Center");
  assert.equal(afterSurgeryUpdate.postCampSurgeryDate, "2026-11-05");
  assert.equal(afterSurgeryUpdate.postCampSurgeryVenue, "General Hospital");
});
