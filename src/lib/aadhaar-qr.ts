/**
 * Pure function Aadhaar QR payload decoder (#92).
 * Parses XML (<PrintLetterBarcodeData ...>), Secure QR (2018+ UIDAI gzip/binary/numeric byte arrays), JSON, and Key-Value Aadhaar QR payloads.
 * Strictly performs no network requests and performs no cryptographic signature verification.
 */

import { normalizeGender } from "@/lib/aadhaar";

export type ParsedAadhaarQr = {
  fullName: string | null;
  gender: "M" | "F" | "O" | null;
  age: number | null;
  address: string | null;
  aadhaarLast4: string | null;
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

/**
 * Checks if a string contains non-Latin script characters
 * (e.g. Devanagari \u0900-\u097F, Tamil \u0B80-\u0BFF, Telugu, Bengali, Arabic, etc.).
 */
export function isNonLatinText(text: string | null | undefined): boolean {
  if (!text) return false;
  return /[^\u0000-\u007F\u00A0-\u024F\s\.,'-]/u.test(text);
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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

    let year: number | null = null;
    let month: number | null = null;
    let day: number | null = null;

    // Format: YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
    const isoMatch = trimmed.match(/^(\d{4})[-/\.](\d{1,2})[-/\.](\d{1,2})(?:T.*)?$/);
    // Format: DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY
    const dmyMatch = trimmed.match(/^(\d{1,2})[-/\.](\d{1,2})[-/\.](\d{4})$/);

    if (isoMatch) {
      year = parseInt(isoMatch[1], 10);
      month = parseInt(isoMatch[2], 10);
      day = parseInt(isoMatch[3], 10);
    } else if (dmyMatch) {
      day = parseInt(dmyMatch[1], 10);
      month = parseInt(dmyMatch[2], 10);
      year = parseInt(dmyMatch[3], 10);
    }

    if (
      year !== null &&
      month !== null &&
      day !== null &&
      year >= 1875 &&
      year <= now.getFullYear() &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      let age = now.getFullYear() - year;
      const currentMonth = now.getMonth() + 1;
      const currentDay = now.getDate();

      if (
        currentMonth < month ||
        (currentMonth === month && currentDay < day)
      ) {
        age -= 1;
      }

      if (age >= 0 && age < 150) {
        return age;
      }
    }
  }

  if (yobStr != null) {
    const yob = typeof yobStr === "number" ? yobStr : parseInt(String(yobStr).trim(), 10);
    if (!isNaN(yob) && yob >= 1875 && yob <= now.getFullYear()) {
      const age = now.getFullYear() - yob;
      if (age >= 0 && age < 150) {
        return age;
      }
    }
  }

  return null;
}

/**
 * Combine address components into a single display string.
 */
export function buildAddress(fields: Record<string, string | null | undefined>): string | null {
  const parts: string[] = [];
  const keyAliases: string[][] = [
    ["co", "careof", "c_o", "c/o"],
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
    if (val && !parts.includes(val)) {
      parts.push(val);
    }
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Synchronously decompress gzip bytes if running in Node environment */
function decompressGzipSync(bytes: Uint8Array): Uint8Array | null {
  if (isGzip(bytes)) {
    try {
      if (typeof window === "undefined" && typeof process !== "undefined" && process.versions?.node) {
        const getReq = new Function("return require");
        const zlib = getReq()("node:zlib");
        return new Uint8Array(zlib.gunzipSync(bytes));
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Browser-capable decompression. `decompressGzipSync` is Node-only, so in the
 * browser every 2018+ Secure QR fell through to the last-4-digits fallback and
 * nothing was autofilled. DecompressionStream is async, hence the async parser.
 *
 * Producers in the wild wrap the same payload as gzip, zlib, or raw deflate, so
 * all three are attempted before giving up.
 */
async function decompress(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (bytes.length < 3) return null;

  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (Ctor) {
    // gzip magic first; zlib streams start 0x78, raw deflate has no header.
    const formats: CompressionFormat[] = isGzip(bytes)
      ? ["gzip", "deflate", "deflate-raw"]
      : bytes[0] === 0x78
        ? ["deflate", "deflate-raw", "gzip"]
        : ["deflate-raw", "deflate", "gzip"];
    for (const format of formats) {
      try {
        const stream = new Blob([bytes as BlobPart])
          .stream()
          .pipeThrough(new Ctor(format));
        const out = new Uint8Array(await new Response(stream).arrayBuffer());
        if (out.length) return out;
      } catch {
        /* try the next format */
      }
    }
  }

  return decompressGzipSync(bytes);
}

/** Converts BigInt / numeric digit string to Uint8Array */
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

/** Parse delimited Secure Aadhaar QR fields */
function parseSecureAadhaarFields(parts: string[], now: Date): ParsedAadhaarQr | null {
  if (!parts || parts.length < 3) return null;

  // Field order after the reference ID:
  //   Name, DOB, Gender, Care Of, District, Landmark, House, Location,
  //   Pincode, Post Office, State, Street, Sub-district, VTC
  // A real UIDAI Secure QR (V2) prefixes an email/mobile indicator field, so the
  // reference ID sits at index 1, not 0. Anchor on the DOB field rather than fixed
  // indices so both layouts parse.
  const dobIdx = parts.findIndex((p) =>
    /^\d{1,2}[-/\.]\d{1,2}[-/\.]\d{4}$/.test(p?.trim() || ""),
  );
  const nameIdx = dobIdx >= 1 ? dobIdx - 1 : 1;

  const name = parts[nameIdx]?.trim() || null;
  const dob = parts[nameIdx + 1]?.trim() || null;
  const gnd = parts[nameIdx + 2]?.trim() || null;

  const addrFields: Record<string, string> = {
    co: parts[nameIdx + 3] || "",
    dist: parts[nameIdx + 4] || "",
    lm: parts[nameIdx + 5] || "",
    house: parts[nameIdx + 6] || "",
    loc: parts[nameIdx + 7] || "",
    pincode: parts[nameIdx + 8] || "",
    po: parts[nameIdx + 9] || "",
    state: parts[nameIdx + 10] || "",
    street: parts[nameIdx + 11] || "",
    subdist: parts[nameIdx + 12] || "",
    vtc: parts[nameIdx + 13] || "",
  };

  // Reference ID is "<Aadhaar last 4><timestamp>", so the last 4 digits are the
  // timestamp's, not the Aadhaar's, once a timestamp is actually present.
  const digitsInRef = (parts[nameIdx - 1] || "").replace(/\D/g, "");
  const aadhaarLast4 =
    digitsInRef.length >= 16
      ? digitsInRef.slice(0, 4)
      : digitsInRef.length >= 4
        ? digitsInRef.slice(-4)
        : null;

  const age = calculateAge(dob, null, now);
  const gender = normalizeGender(gnd);
  const address = buildAddress(addrFields);

  if (name || aadhaarLast4) {
    return {
      fullName: name,
      gender,
      age,
      address,
      aadhaarLast4,
      isNonLatinName: isNonLatinText(name),
      source: "secure_qr" as const,
    };
  }

  return null;
}

/** Our own desk-slip / status QR codes, matched on structure not substrings. */
function looksLikeSnpSlip(trimmed: string): boolean {
  if (trimmed.startsWith("SNP-")) return true;

  const lower = trimmed.toLowerCase();
  // Our status and desk URLs.
  if (
    /^https?:\/\//.test(lower) &&
    (lower.includes("/s/") || lower.includes("/desk"))
  ) {
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

/**
 * Parse an Aadhaar QR payload string (XML, JSON, Key-Value, or Secure QR).
 * Rejects SNP patient desk slip QR code with an explicit message.
 */
export function parseAadhaarQr(
  payload: string,
  now: Date = new Date(),
): ParsedAadhaarQr {
  if (!payload || typeof payload !== "string") {
    throw new Error("Invalid or unreadable Aadhaar QR code.");
  }

  const trimmed = payload.trim();

  // 1. Detect Base64-encoded XML payloads (common in legacy cards & e-Aadhaar downloads)
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
      if (
        decoded.includes("PrintLetterBarcodeData") ||
        decoded.toLowerCase().includes("printletterbarcodedata") ||
        (decoded.includes("<") && decoded.includes(">"))
      ) {
        return parseAadhaarQr(decoded, now);
      }
    } catch {
      /* not base64 */
    }
  }

  // 2. Detect SNP patient QR codes (desk slips / internal patient QRs).
  // Matched structurally, not by substring: a legacy Aadhaar address such as
  // house="12/S/4" contains "/s/" and must not be mistaken for a desk slip.
  if (looksLikeSnpSlip(trimmed)) {
    throw new Error(
      "This is an SNP patient desk slip QR code, not an Aadhaar card. Please scan the patient's Aadhaar card.",
    );
  }

  // 3. Parse XML format (<PrintLetterBarcodeData .../>)
  const isXml =
    trimmed.includes("PrintLetterBarcodeData") ||
    trimmed.toLowerCase().includes("printletterbarcodedata") ||
    (trimmed.startsWith("<") && (trimmed.endsWith(">") || trimmed.includes(">"))) ||
    /<[a-zA-Z0-9_:-]+[^>]*>/i.test(trimmed);

  if (isXml) {
    const decodedPayload = decodeXmlEntities(trimmed);
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/gi;
    let match: RegExpExecArray | null;

    while ((match = attrRegex.exec(decodedPayload)) !== null) {
      const rawKey = match[1].toLowerCase();
      const key = rawKey.includes(":") ? rawKey.split(":")[1] : rawKey;
      const val = match[2] ?? match[3] ?? match[4] ?? "";
      attrs[key] = val;
    }

    const uid =
      attrs["uid"] ||
      attrs["aadhaar"] ||
      attrs["aadhaarnumber"] ||
      attrs["a"] ||
      attrs["u"] ||
      "";
    const rawName =
      attrs["name"] ||
      attrs["fullname"] ||
      attrs["full_name"] ||
      attrs["name_en"] ||
      attrs["name-en"] ||
      attrs["name_eng"] ||
      null;
    let name = rawName;
    if (isNonLatinText(name)) {
      const en =
        attrs["name_en"] ||
        attrs["name-en"] ||
        attrs["name_eng"] ||
        attrs["fullname_en"];
      if (en && !isNonLatinText(en)) {
        name = en;
      }
    }

    const gnd = attrs["gender"] || attrs["gnd"] || attrs["g"] || null;
    const dob = attrs["dob"] || attrs["dateofbirth"] || attrs["d_o_b"] || null;
    const yob = attrs["yob"] || attrs["yearofbirth"] || attrs["y_o_b"] || null;
    const aadhaarLast4 = uid.replace(/\D/g, "").slice(-4) || null;

    const age = calculateAge(dob, yob, now);
    const gender = normalizeGender(gnd);
    const address = buildAddress(attrs);

    if (!name && !aadhaarLast4 && !dob && !yob) {
      throw new Error("Invalid or unreadable Aadhaar QR code.");
    }

    return {
      fullName: name,
      gender,
      age,
      address,
      aadhaarLast4,
      isNonLatinName: isNonLatinText(name),
      source: "legacy_xml" as const,
    };
  }

  // 3. Parse JSON format
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      const name = obj.name || obj.fullName || obj.name_en || null;
      const gnd = obj.gender || obj.gnd || null;
      const dob = obj.dob || null;
      const yob = obj.yob || null;
      const directAge = obj.age || obj.u_age || null;
      const uid = String(obj.uid || obj.aadhaar || obj.aadhaarLast4 || "");
      const aadhaarLast4 = uid.replace(/\D/g, "").slice(-4) || null;

      const age = calculateAge(dob || directAge, yob, now);
      const gender = normalizeGender(gnd);
      const address =
        typeof obj.address === "string"
          ? obj.address
          : buildAddress(obj as Record<string, string>);

      return {
        fullName: name,
        gender,
        age,
        address,
        aadhaarLast4,
        isNonLatinName: isNonLatinText(name),
        source: "unknown" as const,
      };
    } catch {
      /* fallthrough */
    }
  }

  // 4. Parse Key-Value pair format (e.g. name=John&dob=1990-01-01)
  if (trimmed.includes("=") && (trimmed.includes("&") || trimmed.includes("\n"))) {
    const kvs: Record<string, string> = {};
    const pairs = trimmed.split(/[&\n]/);
    for (const p of pairs) {
      const [k, v] = p.split("=");
      if (k && v) {
        kvs[k.trim().toLowerCase()] = v.trim();
      }
    }
    if (kvs["name"] || kvs["uid"] || kvs["dob"]) {
      const name = kvs["name"] || null;
      const uid = kvs["uid"] || kvs["aadhaar"] || "";
      const aadhaarLast4 = uid.replace(/\D/g, "").slice(-4) || null;
      const age = calculateAge(kvs["dob"], kvs["yob"], now);
      const gender = normalizeGender(kvs["gender"] || kvs["gnd"]);
      const address = buildAddress(kvs);

      return {
        fullName: name,
        gender,
        age,
        address,
        aadhaarLast4,
        isNonLatinName: isNonLatinText(name),
        source: "unknown" as const,
      };
    }
  }

  // 5. Delimited text format (e.g. fields separated by \u00FF / ÿ / | )
  if (trimmed.includes("\u00FF") || trimmed.includes("ÿ") || trimmed.includes("\xFF")) {
    const parts = trimmed.split(/\u00FF|\xFF|ÿ/);
    const parsed = parseSecureAadhaarFields(parts, now);
    if (parsed) return parsed;
  }

  // 6. Secure Aadhaar QR / Numeric strings (BigInt decimal sequence or decompressed byte sequence)
  if (/^\d{50,}$/.test(trimmed)) {
    const bytes = numericStringToBytes(trimmed);
    // Legacy numeric-mode QR is uncompressed — the integer *is* the XML bytes.
    // Secure QR is gzipped. Try both, decoded as text.
    for (const payload of [decompressGzipSync(bytes), bytes]) {
      if (!payload) continue;
      const strIso = textDecodings(payload)[0];
      if (strIso.startsWith("<") || strIso.startsWith("{")) {
        const xmlParsed = tryParse(strIso, now);
        if (xmlParsed) return xmlParsed;
      }
      const parts = strIso.split(/\u00FF|\xFF|ÿ/);
      const parsed = parseSecureAadhaarFields(parts, now);
      if (parsed) return parsed;
    }
  }

  throw new Error("Invalid or unreadable Aadhaar QR code.");
}

function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder("iso-8859-1").decode(bytes);
}

/**
 * Text decodings to try for a byte payload, best first.
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

/** Parse succeeded only if it yielded a field we would actually autofill. */
function isUseful(parsed: ParsedAadhaarQr | null): parsed is ParsedAadhaarQr {
  return Boolean(
    parsed && (parsed.fullName || parsed.age != null || parsed.gender),
  );
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
 * Aadhaar Secure QR is byte-mode binary, so the decoder's *text* is a lossy
 * UTF-8 decode that cannot be decompressed; only `bytes` round-trips. Callers
 * should pass bytes whenever the decoder exposes them.
 */
export async function parseAadhaarQrAsync(
  payload: string | Uint8Array,
  now: Date = new Date(),
): Promise<ParsedAadhaarQr> {
  const candidates: Uint8Array[] = [];
  const text = typeof payload === "string" ? payload.trim() : "";

  if (payload instanceof Uint8Array) {
    candidates.push(payload);
  } else if (/^\d{50,}$/.test(text)) {
    // Numeric-mode Secure QR: one huge decimal integer over the byte stream.
    candidates.push(numericStringToBytes(text));
  }

  for (const bytes of candidates) {
    const decompressed = await decompress(bytes);
    if (decompressed) {
      for (const text of textDecodings(decompressed)) {
        const parsed = tryParse(text, now);
        if (isUseful(parsed)) return parsed;
      }
    }
    // Uncompressed byte-mode payload (legacy XML cards encode plain text here).
    for (const text of textDecodings(bytes)) {
      const parsed = tryParse(text, now);
      if (isUseful(parsed)) return parsed;
    }
  }

  if (typeof payload !== "string") {
    // Bytes were given but nothing parsed — surface the standard error.
    return parseAadhaarQr(decodeLatin1(payload), now);
  }

  return parseAadhaarQr(payload, now);
}
