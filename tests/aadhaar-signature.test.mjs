import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyAadhaarQrSignature,
} from "../src/lib/aadhaar-verifier.ts";
import { AADHAAR_CERTIFICATE } from "../src/lib/aadhaar-cert.ts";

const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDQulX9iiZz6iF0
J2FfXVJtNHGVvRFpnV4GwcKRDBBmcpv4n17gjiTKfi6Ke+5O9GcWgVLdSPBMn+a0
d7V7ZqAvk7xJdtk25P3hlNc5T+5a08EEEiY+j0VQk5KJQcEQFcpE9d2B7KuZAWtF
5OWL0ca06haWLlCfh0/G4Dntvq+HkpyJFv3qeHN/0yLgy7ty6I5PGOn5Sy43MtS1
mF7XQqB2cTf7CTsdo3YGvUAesuK3kNZ+S7pdKtBKz+d3dg/azhVUvHcAgimNkqRm
HqPve8R1FBDCLf+FTsghP05cONLPEk4LyLn9q6UycTSINZUPqWN85bVxj7p7XhiV
7r5GAW0nAgMBAAECggEASH1WTOn0RdB70tO0aQLHlB6hDgBuMjBRjeYv9ODsNzA5
g+SRdkpXc63T6wt0bZ5KyRGb3jctIWdtH6Ltd9Bh9HQJ8behY4Ouum/POVvNq2Sc
RZYqCxMF3yCJRTr9WmE+8Kk0xyETTV2lTE5c/CycJouf0YN/Q5AiQC7yX2OYoWvD
ucMyJ9tRf4gP5lq2V0gI0MVh5MuG2RSM7f9zmMXrRth0pq8d3ux8ErgS43CkW177
4NBet7jEgafvmwkgbhHUeKVX0bi4iKESg+t8CSeZX/IeHnaDtWsEqX0wAO0JKHDT
CcPTZ0CQhoifI9PyNkf/ZqpPP30s2DojSEKyUOdoJQKBgQD+qxz0LPHbcQ2QZsl7
OE2DsWUwdyf/bVY0b6wotAwxjsNtxaMunBPFkum57QZtfJj2fXlz7FeSaVPklNjg
71fDTqaa2EJ4UCUtnQNSalsw3f6bRiguKkGGVDldCxOhaFAfaSBqi+ro2yo+CsN3
UCc6fC5yxGM/W6Mfw1Rk8iBxSwKBgQDR0bqgEDZjqDLxtel52DgSuNn26CGUEOFJ
vsGsEj7Z+R8Hwl9bHtT1Fp8qZZ7CvLMJg7wJ05zUQA9ldBfIMwK2QbMUJwcqNYfW
gJrfMVNo1nPgNLv1cyiK7rHIa2nbvYLY8HJ0g/I3WUWgyMIos11FkduKWSCTyQo+
oEr37DUmFQKBgQDjnW6Icu9MEdRsvuHPxvfI/7GQSr+uFTwaK8F0s8++L3pOT3nU
+9zUFsXdzpKTIuzYSjdWO+PdUVSRFdRt3p3TSyWveiCWxhMknJROgg61M4UPpPne
oRflhruqhG7sMX6DRIOblyjDLLepshcYOcSGCl29Z/fItg+rIPr6KkqC1wKBgDin
iNzvg8AlCpx5ojFkUL+9ah1hUK/KXwqql2D/DDmPKvHNajIQgTAsi43HIrcyfKV1
DLEakp49LesXDdTg8TqFQvWOFEExcxxYXXkmuH72aROBKb98+NWK3jZfypWq9knd
owoTFrQbRtHDY6nZxLWkTMNujX1aK4n9fkCzZyaBAoGBAICkwd6j64vKrOWfyGEy
JFWQZ/QvKaTRmZtboONaHetF3UqGE0YWnpx5cdU+Bt1ATHaU4EqCodbpwjgEus7L
dpfHSDZwt5DLlq920+13elvOY2BZnCDxsYEZhnwWe/Zp6LmMisvyWVnx5xCEqH1m
pFBfIkPbF2wIF9sg67/TB3r+
-----END PRIVATE KEY-----`;

function createSignedXml(dataXml) {
  const signer = crypto.createSign("SHA256");
  signer.update(dataXml);
  const sigBase64 = signer.sign(TEST_PRIVATE_KEY_PEM, "base64");
  return `<PrintLetterBarcodeData uid="987654321098" name="Vikram Sharma" gender="M" dob="15-08-1990" house="42" vtc="Jaipur" state="Rajasthan" pc="302001" signature="${sigBase64}"/>`;
}

test("Aadhaar signature verifier — valid signature payload returns card_verified", () => {
  const dataXml = `<PrintLetterBarcodeData uid="987654321098" name="Vikram Sharma" gender="M" dob="15-08-1990" house="42" vtc="Jaipur" state="Rajasthan" pc="302001"/>`;
  const signedPayload = createSignedXml(dataXml);

  const result = verifyAadhaarQrSignature(signedPayload, {
    now: new Date("2026-07-27T12:00:00Z"),
  });

  assert.equal(result.isVerified, true);
  assert.equal(result.provenance, "card_verified");
  assert.equal(result.error, undefined);
});

test("Aadhaar signature verifier — tampered signature payload is rejected", () => {
  const dataXml = `<PrintLetterBarcodeData uid="987654321098" name="Vikram Sharma" gender="M" dob="15-08-1990" house="42" vtc="Jaipur" state="Rajasthan" pc="302001"/>`;
  const signer = crypto.createSign("SHA256");
  signer.update(dataXml);
  const sigBase64 = signer.sign(TEST_PRIVATE_KEY_PEM, "base64");

  // Tamper the name in payload while retaining original signature
  const tamperedPayload = `<PrintLetterBarcodeData uid="987654321098" name="TAMPERED NAME" gender="M" dob="15-08-1990" house="42" vtc="Jaipur" state="Rajasthan" pc="302001" signature="${sigBase64}"/>`;

  const result = verifyAadhaarQrSignature(tamperedPayload, {
    now: new Date("2026-07-27T12:00:00Z"),
  });

  assert.equal(result.isVerified, false);
  assert.equal(result.provenance, "self_declared");
  assert.match(
    result.error || "",
    /Signature verification failed or certificate expired/,
  );
});

test("Aadhaar signature verifier — expired certificate is rejected with certificate expiry error", () => {
  const dataXml = `<PrintLetterBarcodeData uid="987654321098" name="Vikram Sharma" gender="M" dob="15-08-1990" house="42" vtc="Jaipur" state="Rajasthan" pc="302001"/>`;
  const signedPayload = createSignedXml(dataXml);

  // Pass a date after cert expiration (cert expires 2028-12-31)
  const result = verifyAadhaarQrSignature(signedPayload, {
    now: new Date("2030-01-01T12:00:00Z"),
  });

  assert.equal(result.isVerified, false);
  assert.equal(result.provenance, "self_declared");
  assert.match(
    result.error || "",
    /Signature verification failed or certificate expired/,
  );
});

test("Aadhaar signature verifier — custom expired certificate metadata rejected", () => {
  const dataXml = `<PrintLetterBarcodeData uid="987654321098" name="Vikram Sharma" gender="M" dob="15-08-1990"/>`;
  const signedPayload = createSignedXml(dataXml);

  const expiredCert = {
    ...AADHAAR_CERTIFICATE,
    expiresAt: "2025-01-01T00:00:00.000Z",
  };

  const result = verifyAadhaarQrSignature(signedPayload, {
    certificate: expiredCert,
    now: new Date("2026-07-27T12:00:00Z"),
  });

  assert.equal(result.isVerified, false);
  assert.equal(result.provenance, "self_declared");
  assert.match(
    result.error || "",
    /Signature verification failed or certificate expired/,
  );
});

function applyFieldEditDowngrade(
  currentProvenance,
  initialValues,
  field,
  newValue,
) {
  if (currentProvenance !== "card_verified" || !initialValues) {
    return currentProvenance;
  }
  if (field === "fullName" && newValue !== initialValues.fullName) {
    return "self_declared";
  }
  if (field === "aadhaarLast4" && newValue !== initialValues.aadhaarLast4) {
    return "self_declared";
  }
  return currentProvenance;
}

test("Field edit provenance downgrade rules — editing fullName or aadhaarLast4 downgrades to self_declared", () => {
  const initial = { fullName: "Vikram Sharma", aadhaarLast4: "1098" };
  const prov = "card_verified";

  // Same values -> stay card_verified
  assert.equal(
    applyFieldEditDowngrade(prov, initial, "fullName", "Vikram Sharma"),
    "card_verified",
  );
  assert.equal(
    applyFieldEditDowngrade(prov, initial, "aadhaarLast4", "1098"),
    "card_verified",
  );

  // Edit fullName -> downgrade to self_declared
  assert.equal(
    applyFieldEditDowngrade(prov, initial, "fullName", "Vikram Kumar"),
    "self_declared",
  );

  // Edit aadhaarLast4 -> downgrade to self_declared
  assert.equal(
    applyFieldEditDowngrade(prov, initial, "aadhaarLast4", "9999"),
    "self_declared",
  );
});

test("Field edit provenance downgrade rules — editing address, phone, gender, or age preserves card_verified", () => {
  const initial = { fullName: "Vikram Sharma", aadhaarLast4: "1098" };
  const prov = "card_verified";

  // Address edit -> preserves card_verified
  assert.equal(
    applyFieldEditDowngrade(prov, initial, "address", "42 MG Road, Jaipur"),
    "card_verified",
  );

  // Phone edit -> preserves card_verified
  assert.equal(
    applyFieldEditDowngrade(prov, initial, "phone", "9876543210"),
    "card_verified",
  );

  // Gender edit -> preserves card_verified
  assert.equal(
    applyFieldEditDowngrade(prov, initial, "gender", "F"),
    "card_verified",
  );

  // Age edit -> preserves card_verified
  assert.equal(
    applyFieldEditDowngrade(prov, initial, "age", "36"),
    "card_verified",
  );
});
