import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  parseAadhaarQr,
  parseAadhaarQrAsync,
  calculateAge,
  isNonLatinText,
  buildAddress,
} from "../src/lib/aadhaar-qr.ts";

const FIXTURE_DATE = new Date("2026-07-27T12:00:00Z");

test("XML Aadhaar QR extraction — standard XML payload", () => {
  const xmlPayload = `<PrintLetterBarcodeData uid="987654321098" name="Vikram Sharma" gender="M" dob="15-08-1990" house="42" street="MG Road" lm="Near Clock Tower" vtc="Jaipur" dist="Jaipur" state="Rajasthan" pc="302001"/>`;

  const parsed = parseAadhaarQr(xmlPayload, FIXTURE_DATE);

  assert.equal(parsed.fullName, "Vikram Sharma");
  assert.equal(parsed.gender, "M");
  assert.equal(parsed.age, 35); // Aug 15 1990 has NOT occurred by July 27 2026 -> 35
  assert.equal(parsed.aadhaarLast4, "1098");
  assert.equal(parsed.isNonLatinName, false);
  assert.equal(
    parsed.address,
    "42, MG Road, Near Clock Tower, Jaipur, Rajasthan, 302001",
  );
});

test("XML Aadhaar QR extraction — DOB already occurred this year", () => {
  const xmlPayload = `<PrintLetterBarcodeData uid="111122223333" name="Priya Patel" gnd="F" dob="10/04/1995" vtc="Ahmedabad" state="Gujarat" pc="380001"/>`;

  const parsed = parseAadhaarQr(xmlPayload, FIXTURE_DATE);

  assert.equal(parsed.fullName, "Priya Patel");
  assert.equal(parsed.gender, "F");
  assert.equal(parsed.age, 31); // April 10 1995 HAS occurred by July 27 2026 -> 31
  assert.equal(parsed.aadhaarLast4, "3333");
});

test("XML Aadhaar QR extraction — YOB only when DOB missing", () => {
  const xmlPayload = `<PrintLetterBarcodeData uid="555566667777" name="Ramesh Kumar" gender="MALE" yob="1980" dist="Sikar" state="Rajasthan"/>`;

  const parsed = parseAadhaarQr(xmlPayload, FIXTURE_DATE);

  assert.equal(parsed.fullName, "Ramesh Kumar");
  assert.equal(parsed.gender, "M");
  assert.equal(parsed.age, 46); // 2026 - 1980 -> 46
  assert.equal(parsed.aadhaarLast4, "7777");
});

test("Age calculation — leap year birthday and boundary checks", () => {
  const refDate = new Date("2026-07-27T12:00:00Z");
  assert.equal(calculateAge("29-02-2000", null, refDate), 26);
  assert.equal(calculateAge("27-07-1990", null, refDate), 36); // Birthday today
  assert.equal(calculateAge("28-07-1990", null, refDate), 35); // Birthday tomorrow
  assert.equal(calculateAge(null, "1970", refDate), 56);
  assert.equal(calculateAge("invalid", "invalid", refDate), null);
});

test("Non-Latin name detection", () => {
  assert.equal(isNonLatinText("Vikram Sharma"), false);
  assert.equal(isNonLatinText("Priya Patel"), false);
  assert.equal(isNonLatinText("विक्रम शर्मा"), true); // Devanagari
  assert.equal(isNonLatinText("பிரியா"), true); // Tamil
  assert.equal(isNonLatinText("విక్రమ్"), true); // Telugu
});

test("XML Aadhaar QR extraction — Devanagari non-Latin name", () => {
  const xmlPayload = `<PrintLetterBarcodeData uid="123412341234" name="विक्रम शर्मा" gnd="M" dob="01-01-1985" vtc="Jaipur"/>`;

  const parsed = parseAadhaarQr(xmlPayload, FIXTURE_DATE);

  assert.equal(parsed.fullName, "विक्रम शर्मा");
  assert.equal(parsed.isNonLatinName, true);
  assert.equal(parsed.gender, "M");
  assert.equal(parsed.age, 41);
});

test("Rejection of SNP patient desk slip QR code with explicit error message", () => {
  const snpDeskSlipQr1 = JSON.stringify({ reg_no: 1042, token: "abc-123", camp_id: "c1" });
  const snpDeskSlipQr2 = "SNP-PATIENT-1042";
  const snpDeskSlipQr3 = "https://snpcamps.org/s/token123";

  assert.throws(
    () => parseAadhaarQr(snpDeskSlipQr1),
    /This is an SNP patient desk slip QR code, not an Aadhaar card/,
  );

  assert.throws(
    () => parseAadhaarQr(snpDeskSlipQr2),
    /This is an SNP patient desk slip QR code, not an Aadhaar card/,
  );

  assert.throws(
    () => parseAadhaarQr(snpDeskSlipQr3),
    /This is an SNP patient desk slip QR code, not an Aadhaar card/,
  );
});

test("Rejection of malformed/unreadable payload", () => {
  assert.throws(
    () => parseAadhaarQr("hello world random text"),
    /Invalid or unreadable Aadhaar QR code/,
  );

  assert.throws(
    () => parseAadhaarQr(""),
    /Invalid or unreadable Aadhaar QR code/,
  );
});

test("Address building from components", () => {
  const addr = buildAddress({
    house: "12",
    street: "Station Road",
    vtc: "Jaipur",
    state: "Rajasthan",
    pc: "302001",
  });
  assert.equal(addr, "12, Station Road, Jaipur, Rajasthan, 302001");
  assert.equal(buildAddress({}), null);
});

test("JSON formatted Aadhaar QR parsing", () => {
  const jsonPayload = JSON.stringify({
    name: "Sunita Devi",
    gender: "F",
    dob: "1992-03-20",
    uid: "444455556666",
    address: "Ward 12, Sikar, Rajasthan",
  });

  const parsed = parseAadhaarQr(jsonPayload, FIXTURE_DATE);

  assert.equal(parsed.fullName, "Sunita Devi");
  assert.equal(parsed.gender, "F");
  assert.equal(parsed.age, 34);
  assert.equal(parsed.aadhaarLast4, "6666");
  assert.equal(parsed.isNonLatinName, false);
});

test("XML Aadhaar QR extraction — single quotes and HTML entities", () => {
  const xmlPayload = `<PrintLetterBarcodeData uid='987654321098' name='Vikram &amp; Sharma' gender='M' dob='15.08.1990' vtc='Jaipur'/>`;

  const parsed = parseAadhaarQr(xmlPayload, FIXTURE_DATE);

  assert.equal(parsed.fullName, "Vikram & Sharma");
  assert.equal(parsed.gender, "M");
  assert.equal(parsed.age, 35);
  assert.equal(parsed.aadhaarLast4, "1098");
});

test("Delimited Secure Aadhaar QR parsing", () => {
  const securePayload = "202105151098\u00FFVikram Sharma\u00FF15-08-1990\u00FFM\u00FFC/O Sharma\u00FFJaipur\u00FFNear Tower\u00FF42\u00FFMain St\u00FF302001\u00FFPO\u00FFRajasthan\u00FFStreet\u00FFSubdist\u00FFJaipur";

  const parsed = parseAadhaarQr(securePayload, FIXTURE_DATE);

  assert.equal(parsed.fullName, "Vikram Sharma");
  assert.equal(parsed.gender, "M");
  assert.equal(parsed.age, 35);
  assert.equal(parsed.aadhaarLast4, "1098");
  assert.ok(parsed.address?.includes("Jaipur"));
});

/** Real UIDAI Secure QR V2: leading email/mobile indicator, then "<last4><timestamp>". */
const SECURE_V2_PAYLOAD = [
  "2",
  "109820210515103000000",
  "Vikram Sharma",
  "15-08-1990",
  "M",
  "C/O Sharma",
  "Jaipur",
  "Near Tower",
  "42",
  "Main St",
  "302001",
  "PO",
  "Rajasthan",
  "Street",
  "Subdist",
  "Jaipur",
].join("ÿ");

test("Secure QR V2 with leading indicator field parses without an index shift", () => {
  const parsed = parseAadhaarQr(SECURE_V2_PAYLOAD, FIXTURE_DATE);

  assert.equal(parsed.fullName, "Vikram Sharma");
  assert.equal(parsed.gender, "M");
  assert.equal(parsed.age, 35);
  assert.equal(parsed.aadhaarLast4, "1098");
  assert.ok(parsed.address?.includes("Rajasthan"));
});

test("gzipped numeric Secure QR autofills in a browser-like env (no node:zlib path)", async () => {
  const gz = gzipSync(Buffer.from(SECURE_V2_PAYLOAD, "latin1"));
  const numeric = BigInt("0x" + gz.toString("hex")).toString(10);
  assert.ok(/^\d{50,}$/.test(numeric));

  // `window` defined => the Node-only sync gunzip bails out, exactly as in a real
  // browser. Only the DecompressionStream path can satisfy this.
  const hadWindow = "window" in globalThis;
  globalThis.window = globalThis;
  try {
    // Sync parser cannot gunzip here, and must reject rather than invent a last4
    // from the decimal digits.
    assert.throws(() => parseAadhaarQr(numeric, FIXTURE_DATE), /Invalid or unreadable/);

    const parsed = await parseAadhaarQrAsync(numeric, FIXTURE_DATE);
    assert.equal(parsed.fullName, "Vikram Sharma");
    assert.equal(parsed.gender, "M");
    assert.equal(parsed.age, 35);
    assert.equal(parsed.aadhaarLast4, "1098");
  } finally {
    if (!hadWindow) delete globalThis.window;
  }
});

test("Legacy Base64-encoded XML Aadhaar QR decoding", () => {
  const xmlStr = `<PrintLetterBarcodeData uid="123456789012" name="Rakesh Verma" g="M" dateofbirth="10/10/1985" house="101" village="Kota" district="Kota" state="Rajasthan" pincode="324005"/>`;
  const base64Str = Buffer.from(xmlStr, "utf-8").toString("base64");

  const parsed = parseAadhaarQr(base64Str, FIXTURE_DATE);

  assert.equal(parsed.fullName, "Rakesh Verma");
  assert.equal(parsed.gender, "M");
  assert.equal(parsed.age, 40);
  assert.equal(parsed.aadhaarLast4, "9012");
  assert.ok(parsed.address?.includes("Kota"));
});

test("Legacy Aadhaar QR attribute aliases (a, u, dateofbirth, careof, pincode, district)", () => {
  const xmlStr = `<PrintLetterBarcodeData a="555544443333" fullname="Anil Kapoor" g="MALE" dateofbirth="1975-05-20" careof="S/O Ram Kapoor" hno="15" town="Udaipur" district="Udaipur" pincode="313001"/>`;

  const parsed = parseAadhaarQr(xmlStr, FIXTURE_DATE);

  assert.equal(parsed.fullName, "Anil Kapoor");
  assert.equal(parsed.gender, "M");
  assert.equal(parsed.age, 51);
  assert.equal(parsed.aadhaarLast4, "3333");
  assert.ok(parsed.address?.includes("S/O Ram Kapoor"));
  assert.ok(parsed.address?.includes("Udaipur"));
});



/**
 * Legacy (pre-2018) cards use numeric-mode QR: the plain XML bytes encoded as one
 * big decimal integer, uncompressed. Decoders hand that back as digit text or as
 * the ASCII bytes of that text — both used to fall through to a "last 4 digits of
 * the decimal" fallback, autofilling a 4-digit number that was not the Aadhaar.
 */
test("Legacy numeric-mode Aadhaar QR decodes the real fields, not decimal noise", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><PrintLetterBarcodeData uid="987654321098" name="Vikram Sharma" gender="M" yob="1990" house="42" street="MG Road" vtc="Jaipur" dist="Jaipur" state="Rajasthan" pc="302001"/>`;
  const xmlBytes = new TextEncoder().encode(xml);
  let big = 0n;
  for (const b of xmlBytes) big = (big << 8n) | BigInt(b);
  const numeric = big.toString();
  assert.ok(/^\d{50,}$/.test(numeric));
  assert.notEqual(numeric.slice(-4), "1098");

  for (const payload of [numeric, new TextEncoder().encode(numeric), xmlBytes]) {
    const parsed = await parseAadhaarQrAsync(payload, FIXTURE_DATE);
    assert.equal(parsed.fullName, "Vikram Sharma");
    assert.equal(parsed.gender, "M");
    assert.equal(parsed.age, 36);
    assert.equal(parsed.aadhaarLast4, "1098");
    assert.ok(parsed.address?.includes("Jaipur"));
  }

  assert.equal(parseAadhaarQr(numeric, FIXTURE_DATE).aadhaarLast4, "1098");
});
