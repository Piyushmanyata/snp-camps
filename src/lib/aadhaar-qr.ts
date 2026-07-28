/**
 * Aadhaar QR payload parser.
 *
 * Handles every payload shape a camp desk actually meets:
 *   - UIDAI Secure QR (2018+): one huge decimal integer -> BigInt -> bytes ->
 *     inflate -> fields delimited by byte 255.
 *   - Legacy `<PrintLetterBarcodeData …/>` XML, and the compact `<QDA n= g= d=>`
 *     variant, raw or base64-wrapped.
 *   - JSON and key=value payloads seen on third-party reprints.
 *
 * Never makes a network request and never verifies the UIDAI signature — the
 * trailing 256 signature bytes are only stripped so the other field boundaries
 * come out right.
 */

import { inflate, inflateRaw, ungzip } from "pako";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { normalizeGender } from "@/lib/aadhaar";
import { isNonLatinText, parseDateOfBirth } from "@/lib/aadhaar-text";

// Re-exported so existing importers keep one entry point for the parser.
export { isNonLatinText, parseDateOfBirth };

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/** Longest a single scanned text field may be before we treat it as garbage. */
const MAX_FIELD = 180;
/** Longest joined address we will carry into the form. */
const MAX_ADDRESS = 512;

/**
 * Control characters and angle brackets, built from an ASCII-only pattern
 * string so no literal control byte ever lands in this file.
 */
const CONTROL_OR_MARKUP = new RegExp("[\\u0000-\\u001f\\u007f<>]", "g");



/**
 * Scrub one value that came off a QR code.
 *
 * Everything here is untrusted: the payload is whatever was printed on the
 * card, and it flows straight into React state and then into the database.
 * Control characters and angle brackets are dropped rather than escaped, so no
 * caller can reintroduce them as markup, and anything absurdly long is refused
 * outright instead of silently truncated into a half-word.
 */
function cleanText(raw: unknown, max = MAX_FIELD): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.replace(CONTROL_OR_MARKUP, "").trim();
  if (!stripped || stripped.length > max) return null;
  return stripped;
}

const textField = z
  .unknown()
  .transform((value) => cleanText(value))
  .nullable();

/**
 * The one internal shape every payload format collapses to. Address components
 * are kept separately as well as joined, because the desk form shows one line
 * but the Person key and any later export want the parts.
 */
export const AadhaarFieldsSchema = z.object({
  fullName: textField,
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .catch(null),
  yearOfBirth: z.number().int().min(1875).max(2100).nullable().catch(null),
  gender: z.enum(["M", "F", "O"]).nullable().catch(null),
  age: z.number().int().min(0).max(149).nullable().catch(null),
  careOf: textField,
  house: textField,
  street: textField,
  landmark: textField,
  locality: textField,
  vtc: textField,
  postOffice: textField,
  subdistrict: textField,
  district: textField,
  state: textField,
  pincode: z
    .string()
    .regex(/^\d{6}$/, "PIN code must be exactly six digits")
    .nullable()
    .catch(null),
  aadhaarLast4: z
    .string()
    .regex(/^\d{4}$/, "Aadhaar last 4 must be exactly four digits")
    .nullable()
    .catch(null),
});

export type AadhaarFields = z.infer<typeof AadhaarFieldsSchema>;

export type ParsedAadhaarQr = AadhaarFields & {
  /** Address components joined for display, in postal order. */
  address: string | null;
  isNonLatinName: boolean;
  /**
   * Payload origin.
   * - `legacy_xml`  — old unsigned <PrintLetterBarcodeData> XML; data extracted
   *                   but NOT cryptographically verified.
   * - `secure_qr`   — modern UIDAI numeric/binary stream; signature must be
   *                   checked externally to be considered verified.
   * - `unknown`     — format could not be classified (JSON / KV / fallback).
   */
  source: "legacy_xml" | "secure_qr" | "unknown";
};

/* ------------------------------------------------------------------ */
/* Dates, text, addresses                                              */
/* ------------------------------------------------------------------ */


/** Year of birth from either a full DOB or a bare `YYYY`. */
function parseYearOfBirth(
  dobStr?: string | number | null,
  yobStr?: string | number | null,
): number | null {
  const iso = parseDateOfBirth(dobStr);
  if (iso) return parseInt(iso.slice(0, 4), 10);
  const raw = yobStr ?? dobStr;
  if (raw == null) return null;
  const year = typeof raw === "number" ? raw : parseInt(String(raw).trim(), 10);
  return Number.isFinite(year) && year >= 1875 && year <= 2100 ? year : null;
}


/**
 * Calculate age accurately from DOB string (YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD, DD.MM.YYYY, ISO)
 * or YOB string (YYYY), considering the current reference date.
 */
export function calculateAge(
  dobStr?: string | number | null,
  yobStr?: string | number | null,
  now: Date = new Date(),
): number | null {
  if (typeof dobStr === "number" && dobStr >= 0 && dobStr < 150) {
    return Math.floor(dobStr);
  }

  if (dobStr && typeof dobStr === "string") {
    const trimmed = dobStr.trim();

    // Check if dobStr is actually a numeric age (e.g. "35")
    if (/^\d{1,3}$/.test(trimmed)) {
      const parsedVal = parseInt(trimmed, 10);
      if (parsedVal >= 0 && parsedVal < 150) return parsedVal;
    }

    const iso = parseDateOfBirth(trimmed);
    if (iso) {
      const year = parseInt(iso.slice(0, 4), 10);
      const month = parseInt(iso.slice(5, 7), 10);
      const day = parseInt(iso.slice(8, 10), 10);
      if (year <= now.getFullYear()) {
        let age = now.getFullYear() - year;
        const currentMonth = now.getMonth() + 1;
        const currentDay = now.getDate();
        if (currentMonth < month || (currentMonth === month && currentDay < day)) {
          age -= 1;
        }
        if (age >= 0 && age < 150) return age;
      }
    }
  }

  if (yobStr != null) {
    const yob =
      typeof yobStr === "number" ? yobStr : parseInt(String(yobStr).trim(), 10);
    if (!isNaN(yob) && yob >= 1875 && yob <= now.getFullYear()) {
      const age = now.getFullYear() - yob;
      if (age >= 0 && age < 150) return age;
    }
  }

  return null;
}

/** Postal order, so the joined line reads the way an address is written. */
const ADDRESS_ORDER = [
  "careOf",
  "house",
  "street",
  "landmark",
  "locality",
  "vtc",
  "postOffice",
  "subdistrict",
  "district",
  "state",
  "pincode",
] as const;

function joinAddress(fields: AadhaarFields): string | null {
  const parts: string[] = [];
  for (const key of ADDRESS_ORDER) {
    const value = fields[key];
    if (value && !parts.includes(value)) parts.push(value);
  }
  if (!parts.length) return null;
  return parts.join(", ").slice(0, MAX_ADDRESS);
}

/**
 * Combine loose address components into a single display string.
 *
 * Kept exported (and alias-tolerant) because callers outside the parser hand it
 * arbitrary key spellings from third-party payloads.
 */
export function buildAddress(
  fields: Record<string, string | null | undefined>,
): string | null {
  const parts: string[] = [];
  const keyAliases: string[][] = [
    ["co", "careof", "care_of", "c_o", "c/o"],
    ["house", "hno", "house_no", "building"],
    ["street", "street_name"],
    ["lm", "landmark"],
    ["loc", "location", "locality"],
    ["vtc", "village", "city", "town"],
    ["po", "postoffice", "post_office"],
    ["dist", "district", "dist_name"],
    ["subdist", "subdistrict", "subdist_name", "tehsil", "taluk"],
    ["state", "st", "state_name"],
    ["pc", "pincode", "pin", "postalcode"],
  ];

  for (const group of keyAliases) {
    let val: string | undefined;
    for (const k of group) {
      const candidate = fields[k]?.trim();
      if (candidate) {
        val = candidate;
        break;
      }
    }
    if (val && !parts.includes(val)) parts.push(val);
  }

  return parts.length > 0 ? parts.join(", ").slice(0, MAX_ADDRESS) : null;
}

/**
 * Assemble the parsed result, running everything through the schema first so no
 * unvalidated QR text ever reaches a caller.
 */
function finalize(
  raw: Partial<Record<keyof AadhaarFields, unknown>>,
  source: ParsedAadhaarQr["source"],
): ParsedAadhaarQr {
  const fields = AadhaarFieldsSchema.parse({
    fullName: raw.fullName ?? null,
    dateOfBirth: raw.dateOfBirth ?? null,
    yearOfBirth: raw.yearOfBirth ?? null,
    gender: raw.gender ?? null,
    age: raw.age ?? null,
    careOf: raw.careOf ?? null,
    house: raw.house ?? null,
    street: raw.street ?? null,
    landmark: raw.landmark ?? null,
    locality: raw.locality ?? null,
    vtc: raw.vtc ?? null,
    postOffice: raw.postOffice ?? null,
    subdistrict: raw.subdistrict ?? null,
    district: raw.district ?? null,
    state: raw.state ?? null,
    pincode: raw.pincode ?? null,
    aadhaarLast4: raw.aadhaarLast4 ?? null,
  });

  return {
    ...fields,
    address: joinAddress(fields),
    isNonLatinName: isNonLatinText(fields.fullName),
    source,
  };
}

/* ------------------------------------------------------------------ */
/* Aadhaar number extraction                                           */
/* ------------------------------------------------------------------ */

/**
 * Aadhaar last 4 from a uid-ish attribute — only when the value really is a uid.
 *
 * Taking `slice(-4)` of the first candidate attribute is a trap: compact <QDA>
 * cards use `a` for the *address*, so that scrapes the pincode's last four
 * digits and autofills them as the patient's Aadhaar. A uid is 12 digits, or a
 * masked form whose only non-digits are mask characters; anything else is not a
 * uid and yields nothing.
 */
function pickAadhaarLast4(attrs: Record<string, string>): string | null {
  const keys = ["uid", "aadhaar", "aadhaarnumber", "aadhaarlast4", "u", "a"];

  for (const k of keys) {
    const raw = (attrs[k] ?? "").trim();
    if (!raw) continue;
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 12) return digits.slice(-4);
    // Masked uid: "XXXXXXXX1234", "**** **** 1234".
    if (digits.length === 4 && !/[a-wyz0-9]/i.test(raw.replace(/\d/g, ""))) {
      return digits;
    }
  }

  // Unknown key holding a full uid: a bare 12-digit value is a uid and nothing
  // else on these cards (pincode is 6, mobile 10, dates never 12).
  for (const raw of Object.values(attrs)) {
    if (/^\d{12}$/.test(String(raw).trim())) return String(raw).trim().slice(-4);
  }

  return null;
}

/**
 * Address held whole in one attribute, as compact cards do, rather than split
 * into the house/street/vtc components the schema expects.
 */
function pickWholeAddress(attrs: Record<string, string>): string | null {
  for (const k of ["address", "addr", "a", "ad"]) {
    const val = (attrs[k] ?? "").trim();
    // Long enough, and not a bare number that is really a uid or pincode.
    if (val.length >= 10 && /[a-z]/i.test(val)) return val;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Bytes                                                               */
/* ------------------------------------------------------------------ */

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Inflate a Secure QR stream.
 *
 * Producers in the wild wrap the same payload as gzip, zlib, or raw deflate, so
 * all three are attempted. pako is synchronous and identical in Node and the
 * browser, which matters because the same parser runs on the desk (browser) and
 * in the tests (Node).
 */
export function decompress(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 3) return null;
  const attempts = isGzip(bytes)
    ? [ungzip, inflate, inflateRaw]
    : bytes[0] === 0x78
      ? [inflate, inflateRaw, ungzip]
      : [inflateRaw, inflate, ungzip];

  for (const attempt of attempts) {
    try {
      const out = attempt(bytes);
      if (out?.length) return out;
    } catch {
      /* try the next wrapper */
    }
  }
  return null;
}

/** Converts a BigInt / numeric digit string to its big-endian byte array. */
function numericStringToBytes(numericStr: string): Uint8Array {
  try {
    let big = BigInt(numericStr);
    const zero = BigInt(0);
    const ff = BigInt(255);
    const eight = BigInt(8);
    const bytes: number[] = [];
    while (big > zero) {
      bytes.push(Number(big & ff));
      big = big >> eight;
    }
    bytes.reverse();
    return new Uint8Array(bytes);
  } catch {
    return new Uint8Array();
  }
}

function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder("iso-8859-1").decode(bytes);
}

/** One Secure QR text field: UTF-8 when it is valid, ISO-8859-1 otherwise. */
function decodeField(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeLatin1(bytes);
  }
}

/**
 * Text decodings to try for a whole byte payload, best first.
 *
 * Legacy (pre-2018) cards carry plain XML, usually UTF-8 — decoding those as
 * latin-1 mangles any non-ASCII name. Secure QR is binary and must stay latin-1
 * so its bytes survive 1:1. Leading '<' or '{' distinguishes the text cases.
 */
function textDecodings(bytes: Uint8Array): string[] {
  const first = bytes[0];
  const looksLikeText = first === 0x3c || first === 0x7b; // '<' or '{'
  const latin1 = decodeLatin1(bytes);
  if (!looksLikeText) return [latin1];

  try {
    const utf8 = new TextDecoder("utf-8").decode(bytes);
    return utf8 === latin1 ? [latin1] : [utf8, latin1];
  } catch {
    return [latin1];
  }
}

/* ------------------------------------------------------------------ */
/* Secure QR                                                           */
/* ------------------------------------------------------------------ */

/**
 * UIDAI Secure QR text field order, after the leading email/mobile presence
 * indicator and the reference ID.
 */
const SECURE_QR_ORDER = [
  "fullName",
  "dob",
  "gender",
  "careOf",
  "district",
  "landmark",
  "house",
  "locality",
  "pincode",
  "postOffice",
  "state",
  "street",
  "subdistrict",
  "vtc",
] as const;

/**
 * Split the decompressed Secure QR into its leading text fields.
 *
 * Layout is: indicator ÿ refId ÿ <14 text fields> ÿ JP2000 photo [ÿ 32-byte
 * mobile hash] [ÿ 32-byte email hash] <256-byte RSA signature>. Only the text
 * run is wanted, so the scan stops after enough delimiters — the photo is full
 * of 0xFF bytes and splitting it would produce binary garbage fields.
 */
export function splitSecureQrFields(bytes: Uint8Array, max = 16): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length && fields.length < max; i++) {
    if (bytes[i] === 0xff) {
      fields.push(decodeField(bytes.subarray(start, i)));
      start = i + 1;
    }
  }
  return fields;
}

/**
 * Map delimited Secure QR fields onto the schema.
 *
 * V2 payloads prefix an email/mobile indicator, so the reference ID sits at
 * index 1 rather than 0. Rather than trusting either layout, anchor on the DOB
 * field — it is the only one with an unmistakable shape — and read the rest
 * relative to it. Falls back to the documented fixed offset when no date is
 * present at all.
 */
function parseSecureAadhaarFields(
  parts: string[],
  now: Date,
): ParsedAadhaarQr | null {
  if (!parts || parts.length < 3) return null;

  const dobIdx = parts.findIndex((p) =>
    /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(p?.trim() || ""),
  );
  const nameIdx = dobIdx >= 1 ? dobIdx - 1 : 2;

  const at = (offset: number): string | null =>
    parts[nameIdx + offset]?.trim() || null;

  const values: Record<string, string | null> = {};
  SECURE_QR_ORDER.forEach((key, index) => {
    values[key] = at(index);
  });

  // Reference ID is "<Aadhaar last 4><timestamp>", so the last 4 digits belong
  // to the timestamp, not the Aadhaar, once a timestamp is actually present.
  const digitsInRef = (parts[nameIdx - 1] || "").replace(/\D/g, "");
  const aadhaarLast4 =
    digitsInRef.length >= 16
      ? digitsInRef.slice(0, 4)
      : digitsInRef.length >= 4
        ? digitsInRef.slice(-4)
        : null;

  const dob = values.dob;
  if (!values.fullName && !aadhaarLast4) return null;

  return finalize(
    {
      fullName: values.fullName,
      dateOfBirth: parseDateOfBirth(dob),
      yearOfBirth: parseYearOfBirth(dob),
      gender: normalizeGender(values.gender),
      age: calculateAge(dob, null, now),
      careOf: values.careOf,
      house: values.house,
      street: values.street,
      landmark: values.landmark,
      locality: values.locality,
      vtc: values.vtc,
      postOffice: values.postOffice,
      subdistrict: values.subdistrict,
      district: values.district,
      state: values.state,
      pincode: values.pincode?.replace(/\D/g, "") || null,
      aadhaarLast4,
    },
    "secure_qr",
  );
}

/* ------------------------------------------------------------------ */
/* XML                                                                 */
/* ------------------------------------------------------------------ */

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  attributesGroupName: "@",
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

/**
 * Flatten every attribute on every element into one lowercased bag.
 *
 * Aadhaar XML is a single self-closing element, but reprints and wrappers
 * occasionally nest it one level deep, and namespace prefixes (`ns:name`) show
 * up on some third-party exports — so the prefix is dropped and the whole tree
 * is walked rather than assuming a shape.
 */
function collectXmlAttributes(node: unknown, into: Record<string, string>): void {
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "@" && value && typeof value === "object") {
      for (const [attr, attrValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const name = attr.includes(":") ? attr.split(":").pop()! : attr;
        into[name.toLowerCase()] = String(attrValue ?? "");
      }
    } else if (Array.isArray(value)) {
      for (const item of value) collectXmlAttributes(item, into);
    } else if (value && typeof value === "object") {
      collectXmlAttributes(value, into);
    }
  }
}

function parseXmlPayload(payload: string, now: Date): ParsedAadhaarQr | null {
  let tree: unknown;
  try {
    tree = xmlParser.parse(payload);
  } catch {
    return null;
  }

  const attrs: Record<string, string> = {};
  collectXmlAttributes(tree, attrs);
  if (!Object.keys(attrs).length) return null;

  const rawName =
    attrs["name"] ||
    attrs["fullname"] ||
    attrs["full_name"] ||
    attrs["name_en"] ||
    attrs["name-en"] ||
    attrs["name_eng"] ||
    // Compact <QDA n="…" g="M" d="…"> cards use single-letter attributes.
    attrs["n"] ||
    null;

  let name = rawName;
  if (isNonLatinText(name)) {
    const en =
      attrs["name_en"] || attrs["name-en"] || attrs["name_eng"] || attrs["fullname_en"];
    if (en && !isNonLatinText(en)) name = en;
  }

  const gnd = attrs["gender"] || attrs["gnd"] || attrs["g"] || null;
  const dob =
    attrs["dob"] || attrs["dateofbirth"] || attrs["d_o_b"] || attrs["d"] || null;
  const yob =
    attrs["yob"] || attrs["yearofbirth"] || attrs["y_o_b"] || attrs["y"] || null;
  const aadhaarLast4 = pickAadhaarLast4(attrs);

  if (!name && !aadhaarLast4 && !dob && !yob) return null;

  const parsed = finalize(
    {
      fullName: name,
      dateOfBirth: parseDateOfBirth(dob),
      yearOfBirth: parseYearOfBirth(dob, yob),
      gender: normalizeGender(gnd),
      age: calculateAge(dob, yob, now),
      careOf: attrs["co"] || attrs["careof"] || attrs["care_of"] || null,
      house: attrs["house"] || attrs["hno"] || attrs["house_no"] || null,
      street: attrs["street"] || null,
      landmark: attrs["lm"] || attrs["landmark"] || null,
      locality: attrs["loc"] || attrs["location"] || attrs["locality"] || null,
      vtc: attrs["vtc"] || attrs["village"] || attrs["city"] || attrs["town"] || null,
      postOffice: attrs["po"] || attrs["postoffice"] || attrs["post_office"] || null,
      subdistrict: attrs["subdist"] || attrs["subdistrict"] || attrs["tehsil"] || null,
      district: attrs["dist"] || attrs["district"] || null,
      state: attrs["state"] || attrs["st"] || null,
      pincode:
        (attrs["pc"] || attrs["pincode"] || attrs["pin"] || "").replace(/\D/g, "") ||
        null,
      aadhaarLast4,
    },
    "legacy_xml",
  );

  // Compact cards carry the address whole in one attribute rather than split
  // into components, so the joined line comes out empty above.
  if (!parsed.address) {
    const whole = pickWholeAddress(attrs);
    if (whole) return { ...parsed, address: cleanText(whole, MAX_ADDRESS) };
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

/** Our own desk-slip / status QR codes, matched on structure not substrings. */
function looksLikeSnpSlip(trimmed: string): boolean {
  if (trimmed.startsWith("SNP-")) return true;

  const lower = trimmed.toLowerCase();
  // Our status and desk URLs.
  if (/^https?:\/\//.test(lower) && (lower.includes("/s/") || lower.includes("/desk"))) {
    return true;
  }
  // Our JSON slip payloads — keyed fields, not free text that happens to match.
  if (
    trimmed.startsWith("{") &&
    /"(reg_no|token|patientid|patient_id)"\s*:/i.test(trimmed)
  ) {
    return true;
  }
  return false;
}

const UNREADABLE = "Invalid or unreadable Aadhaar QR code.";
const DESK_SLIP =
  "This is an SNP patient desk slip QR code, not an Aadhaar card. Please scan the patient's Aadhaar card.";

/**
 * Parse an Aadhaar QR payload string (XML, JSON, Key-Value, or Secure QR).
 * Rejects SNP patient desk slip QR codes with an explicit message.
 */
export function parseAadhaarQr(
  payload: string,
  now: Date = new Date(),
): ParsedAadhaarQr {
  if (!payload || typeof payload !== "string") throw new Error(UNREADABLE);

  const trimmed = payload.trim();

  // 1. Base64-wrapped XML (common on legacy cards and e-Aadhaar downloads).
  if (
    !trimmed.startsWith("<") &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("SNP-") &&
    /^[A-Za-z0-9+/=\s]{40,}$/.test(trimmed)
  ) {
    try {
      const clean = trimmed.replace(/\s/g, "");
      const decoded =
        typeof window !== "undefined"
          ? atob(clean)
          : Buffer.from(clean, "base64").toString("utf-8");
      if (decoded.includes("<") && decoded.includes(">")) {
        return parseAadhaarQr(decoded, now);
      }
    } catch {
      /* not base64 */
    }
  }

  // 2. Our own patient QR. Matched structurally, not by substring: a legacy
  // Aadhaar address such as house="12/S/4" contains "/s/" and must not be
  // mistaken for a desk slip.
  if (looksLikeSnpSlip(trimmed)) throw new Error(DESK_SLIP);

  // 3. XML — <PrintLetterBarcodeData …/> and the compact <QDA …/> variant.
  if (/<[a-zA-Z0-9_:-]+[^>]*>/.test(trimmed)) {
    const parsed = parseXmlPayload(trimmed, now);
    if (parsed) return parsed;
    if (trimmed.startsWith("<")) throw new Error(UNREADABLE);
  }

  // 4. JSON.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const dob = (obj.dob ?? obj.age ?? obj.u_age) as string | number | null;
      const uid = String(obj.uid ?? obj.aadhaar ?? obj.aadhaarLast4 ?? "");
      const digits = uid.replace(/\D/g, "");
      const flat = obj as Record<string, string>;
      return finalize(
        {
          fullName: obj.name ?? obj.fullName ?? obj.name_en ?? null,
          dateOfBirth: parseDateOfBirth(obj.dob as string),
          yearOfBirth: parseYearOfBirth(obj.dob as string, obj.yob as string),
          gender: normalizeGender((obj.gender ?? obj.gnd) as string),
          age: calculateAge(dob, obj.yob as string, now),
          careOf: flat.co ?? null,
          house: flat.house ?? null,
          street: flat.street ?? null,
          landmark: flat.lm ?? null,
          locality: flat.loc ?? null,
          vtc: flat.vtc ?? null,
          postOffice: flat.po ?? null,
          subdistrict: flat.subdist ?? null,
          district: flat.dist ?? null,
          state: flat.state ?? null,
          pincode: (flat.pc ?? flat.pincode ?? "").replace(/\D/g, "") || null,
          aadhaarLast4: digits.length >= 4 ? digits.slice(-4) : null,
        },
        "unknown",
      );
    } catch {
      /* fallthrough */
    }
  }

  // 5. Key=value pairs (e.g. name=John&dob=1990-01-01).
  if (trimmed.includes("=") && (trimmed.includes("&") || trimmed.includes("\n"))) {
    const kvs: Record<string, string> = {};
    for (const pair of trimmed.split(/[&\n]/)) {
      const [k, v] = pair.split("=");
      if (k && v) kvs[k.trim().toLowerCase()] = v.trim();
    }
    if (kvs["name"] || kvs["uid"] || kvs["dob"]) {
      const digits = (kvs["uid"] || kvs["aadhaar"] || "").replace(/\D/g, "");
      return finalize(
        {
          fullName: kvs["name"] ?? null,
          dateOfBirth: parseDateOfBirth(kvs["dob"]),
          yearOfBirth: parseYearOfBirth(kvs["dob"], kvs["yob"]),
          gender: normalizeGender(kvs["gender"] || kvs["gnd"]),
          age: calculateAge(kvs["dob"], kvs["yob"], now),
          careOf: kvs["co"] ?? null,
          house: kvs["house"] ?? null,
          street: kvs["street"] ?? null,
          landmark: kvs["lm"] ?? null,
          locality: kvs["loc"] ?? null,
          vtc: kvs["vtc"] ?? null,
          postOffice: kvs["po"] ?? null,
          subdistrict: kvs["subdist"] ?? null,
          district: kvs["dist"] ?? null,
          state: kvs["state"] ?? null,
          pincode: (kvs["pc"] || kvs["pincode"] || "").replace(/\D/g, "") || null,
          aadhaarLast4: digits.length >= 4 ? digits.slice(-4) : null,
        },
        "unknown",
      );
    }
  }

  // 6. Already-inflated Secure QR handed to us as text.
  //
  // Guard: require a part that looks like a real date before trusting the
  // split. A still-compressed payload decoded as latin-1 routinely contains
  // 0xFF bytes and would otherwise split into binary garbage, producing a
  // confidently wrong aadhaarLast4.
  if (trimmed.includes("ÿ")) {
    const parts = trimmed.split("ÿ");
    const hasRealDate = parts.some((p) =>
      /^(\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})$/.test(
        p?.trim() || "",
      ),
    );
    if (hasRealDate) {
      const parsed = parseSecureAadhaarFields(parts, now);
      if (parsed) return parsed;
    }
  }

  // 7. Secure QR as one huge decimal integer.
  if (/^\d{50,}$/.test(trimmed)) {
    const bytes = numericStringToBytes(trimmed);
    const parsed = parseAadhaarBytes(bytes, now);
    if (parsed) return parsed;
  }

  throw new Error(UNREADABLE);
}

/**
 * Parse a raw byte payload: inflate when it is compressed, then split on the
 * 0xFF delimiter; fall back to reading the bytes as text for legacy cards,
 * whose numeric-mode QR is the uncompressed XML itself.
 */
function parseAadhaarBytes(
  bytes: Uint8Array,
  now: Date,
): ParsedAadhaarQr | null {
  if (!bytes.length) return null;

  const inflated = decompress(bytes);
  if (inflated) {
    const fields = splitSecureQrFields(inflated);
    const parsed = parseSecureAadhaarFields(fields, now);
    if (isUseful(parsed)) return parsed;
  }

  // Uncompressed byte-mode payload (legacy XML cards encode plain text here).
  for (const text of textDecodings(bytes)) {
    if (text.startsWith("<") || text.startsWith("{")) {
      const parsed = tryParse(text, now);
      if (isUseful(parsed)) return parsed;
    }
  }

  // Uncompressed Secure QR field stream.
  const fields = splitSecureQrFields(bytes);
  const parsed = parseSecureAadhaarFields(fields, now);
  return isUseful(parsed) ? parsed : null;
}

/** Parse succeeded only if it yielded a field we would actually autofill. */
function isUseful(parsed: ParsedAadhaarQr | null): parsed is ParsedAadhaarQr {
  return Boolean(parsed && (parsed.fullName || parsed.age != null || parsed.gender));
}

function tryParse(payload: string, now: Date): ParsedAadhaarQr | null {
  try {
    return parseAadhaarQr(payload, now);
  } catch {
    return null;
  }
}

/**
 * Browser entry point — accepts the QR's raw bytes as well as its text.
 *
 * Aadhaar Secure QR is byte-mode binary, so a decoder's *text* is a lossy UTF-8
 * decode that cannot be inflated; only `bytes` round-trips. Callers should pass
 * bytes whenever the decoder exposes them.
 *
 * Async only for API compatibility with the worker-side caller — pako is
 * synchronous, so nothing here actually awaits.
 */
export async function parseAadhaarQrAsync(
  payload: string | Uint8Array,
  now: Date = new Date(),
): Promise<ParsedAadhaarQr> {
  const candidates: Uint8Array[] = [];
  const text = typeof payload === "string" ? payload.trim() : "";

  if (payload instanceof Uint8Array) {
    candidates.push(payload);
    // Numeric-mode Secure QR reaches us as the ASCII digits of one huge decimal
    // integer, because the camera decoders hand back bytes rather than text.
    // Those digits still have to be converted to the byte stream they encode.
    const digits = decodeLatin1(payload).trim();
    if (/^\d{50,}$/.test(digits)) candidates.push(numericStringToBytes(digits));
  } else if (/^\d{50,}$/.test(text)) {
    candidates.push(numericStringToBytes(text));
  }

  for (const bytes of candidates) {
    const parsed = parseAadhaarBytes(bytes, now);
    if (isUseful(parsed)) return parsed;
  }

  // Nothing above yielded an autofillable field. Re-run so a real parse error
  // (desk slip, unreadable) reaches the operator with its own message — but a
  // result carrying only an aadhaarLast4 is NOT a successful read: every other
  // field is null and that last4 came from a payload we could not interpret.
  // Autofilling it puts four wrong digits in the Aadhaar box, which is worse
  // than saying the card did not read.
  const last = parseAadhaarQr(
    typeof payload === "string" ? payload : decodeLatin1(payload),
    now,
  );
  if (!isUseful(last)) throw new Error(UNREADABLE);
  return last;
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

/**
 * Structure-only fingerprint of a scanned payload, for diagnosing a card format
 * the parser does not yet handle.
 *
 * Deliberately carries NO field values: lengths, byte classes, delimiter counts
 * and a leading-byte hex prefix are enough to identify an encoding, and none of
 * it is patient data. Safe to copy out of a camp desk and paste into an issue.
 */
export function describeQrPayload(payload: string | Uint8Array): string {
  const bytes =
    typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const text = typeof payload === "string" ? payload : decodeLatin1(payload);
  const hex = Array.from(bytes.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

  const bits = [
    `kind=${typeof payload === "string" ? "text" : "bytes"}`,
    `len=${bytes.length}`,
    `head=${hex}`,
    `allDigits=${/^\d+$/.test(text.trim())}`,
    `startsWith=${JSON.stringify(text.trim().slice(0, 1))}`,
    `gzip=${isGzip(bytes)}`,
    `zlib=${bytes[0] === 0x78}`,
    `ffParts=${text.split("ÿ").length}`,
    `hasXmlTag=${/<[a-zA-Z]/.test(text)}`,
  ];

  // Root tag and attribute *names* for an XML payload. Names identify the card
  // variant (<PrintLetterBarcodeData …> vs compact <QDA n= g= d= …>); values are
  // the patient data and are never included.
  const tag = text.match(/<([a-zA-Z][\w:-]*)/);
  if (tag) bits.push(`tag=${tag[1]}`);
  const keys = [...text.matchAll(/([a-zA-Z0-9_:-]+)\s*=\s*["']/g)].map((m) =>
    m[1].toLowerCase(),
  );
  if (keys.length) bits.push(`attrs=${[...new Set(keys)].join(",")}`);

  if (/^\d{50,}$/.test(text.trim())) {
    const decoded = numericStringToBytes(text.trim());
    const inflated = decompress(decoded);
    bits.push(
      `numericDecoded=${decoded.length}`,
      `inflated=${inflated ? inflated.length : 0}`,
      `numericHead=${Array.from(decoded.slice(0, 16))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")}`,
    );
  }

  return bits.join(" ");
}
