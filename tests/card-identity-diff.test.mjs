import assert from "node:assert/strict";
import test from "node:test";
import { diffTypedVsCard } from "../src/lib/card-identity-diff.ts";

const typed = {
  fullName: "Ramesh Kumar",
  dateOfBirth: "1980-01-15",
  gender: "M",
  aadhaarLast4: "4321",
  address: "Ward 1, Sikar",
  displayName: "Ramesh Kumar",
};

test("typed-vs-card diff is empty when every field matches", () => {
  const diff = diffTypedVsCard(typed, { ...typed });
  assert.equal(diff.changed.length, 0);
  assert.equal(diff.promoteDisplayName, false);
});

test("typed-vs-card diff names a single changed field", () => {
  const diff = diffTypedVsCard(typed, { ...typed, address: "Ward 2, Sikar" });
  assert.deepEqual(diff.changed, ["address"]);
  assert.equal(diff.card.address, "Ward 2, Sikar");
  assert.equal(diff.typed.address, "Ward 1, Sikar");
});

test("typed-vs-card diff names every changed identity field", () => {
  const diff = diffTypedVsCard(typed, {
    fullName: "Suresh Kumar",
    dateOfBirth: "1981-02-16",
    gender: "F",
    aadhaarLast4: "9876",
    address: "Jaipur",
  });
  assert.deepEqual(diff.changed, [
    "fullName",
    "dateOfBirth",
    "gender",
    "aadhaarLast4",
    "address",
  ]);
});

test("a non-Latin card name promotes the typed Latin display name", () => {
  const diff = diffTypedVsCard(
    { ...typed, fullName: "Ramesh Kumar", displayName: "Ramesh Kumar" },
    { ...typed, fullName: "रमेश कुमार" },
  );
  assert.ok(diff.changed.includes("fullName"));
  assert.equal(diff.promoteDisplayName, true);
  assert.equal(diff.displayName, "Ramesh Kumar");
});
