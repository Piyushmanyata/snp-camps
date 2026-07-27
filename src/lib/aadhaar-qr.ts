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
  const keys = [
    "co",
    "house",
    "street",
    "lm",
    "loc",
    "vtc",
    "po",
    "dist",
    "subdist",
    "state",
    "pc",
    "pincode",
  ];

  for (const k of keys) {
    const val = fields[k]?.trim();
    if (val && !parts.includes(val)) {
      parts.push(val);
    }
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

/** Synchronously decompress gzip bytes if running in Node environment */
function decompressGzipSync(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      if (typeof process !== "undefined" && process.versions?.node) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const zlib = require("node:zlib");
        return new Uint8Array(zlib.gunzipSync(bytes));
      }
    } catch {
      /* ignore */
    }
  }
  return null;
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

  // Modern UIDAI Secure QR (V2) field index map:
  // Part 0: Reference ID / Timestamp / Email Mobile indicator
  // Part 1: Name
  // Part 2: DOB
  // Part 3: Gender
  // Part 4: Care Of
  // Part 5: District
  // Part 6: Landmark
  // Part 7: House
  // Part 8: Location
  // Part 9: Pincode
  // Part 10: Post Office
  // Part 11: State
  // Part 12: Street
  // Part 13: Sub-district
  // Part 14: VTC

  const name = parts[1]?.trim() || null;
  const dob = parts[2]?.trim() || null;
  const gnd = parts[3]?.trim() || null;

  const addrFields: Record<string, string> = {
    co: parts[4] || "",
    dist: parts[5] || "",
    lm: parts[6] || "",
    house: parts[7] || "",
    loc: parts[8] || "",
    pincode: parts[9] || "",
    po: parts[10] || "",
    state: parts[11] || "",
    street: parts[12] || "",
    subdist: parts[13] || "",
    vtc: parts[14] || "",
  };

  const refId = parts[0] || "";
  const digitsInRef = refId.replace(/\D/g, "");
  const aadhaarLast4 = digitsInRef.length >= 4 ? digitsInRef.slice(-4) : null;

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
    };
  }

  return null;
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

  // 1. Detect SNP patient QR codes (desk slips / internal patient QRs)
  const lower = trimmed.toLowerCase();
  if (
    lower.includes("reg_no") ||
    lower.includes("token") ||
    lower.includes("patientid") ||
    trimmed.startsWith("SNP-") ||
    lower.includes("/s/") ||
    lower.includes("/desk")
  ) {
    throw new Error(
      "This is an SNP patient desk slip QR code, not an Aadhaar card. Please scan the patient's Aadhaar card.",
    );
  }

  // 2. Parse XML format (<PrintLetterBarcodeData .../>)
  if (
    trimmed.includes("PrintLetterBarcodeData") ||
    trimmed.toLowerCase().includes("printletterbarcodedata") ||
    (trimmed.startsWith("<") && trimmed.endsWith(">"))
  ) {
    const decodedPayload = decodeXmlEntities(trimmed);
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let match: RegExpExecArray | null;

    while ((match = attrRegex.exec(decodedPayload)) !== null) {
      const key = match[1].toLowerCase();
      const val = match[2] !== undefined ? match[2] : match[3];
      attrs[key] = val;
    }

    const uid = attrs["uid"] || attrs["aadhaar"] || attrs["aadhaarnumber"] || "";
    const name = attrs["name"] || attrs["fullname"] || attrs["name_en"] || null;
    const gnd = attrs["gender"] || attrs["gnd"] || null;
    const dob = attrs["dob"] || null;
    const yob = attrs["yob"] || null;
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
    const decompressed = decompressGzipSync(bytes);
    if (decompressed) {
      const strIso = new TextDecoder("iso-8859-1").decode(decompressed);
      if (strIso.includes("<PrintLetterBarcodeData") || strIso.startsWith("<")) {
        return parseAadhaarQr(strIso, now);
      }
      if (strIso.startsWith("{")) {
        return parseAadhaarQr(strIso, now);
      }
      const parts = strIso.split(/\u00FF|\xFF|ÿ/);
      const parsed = parseSecureAadhaarFields(parts, now);
      if (parsed) return parsed;
    }

    // Fallback if gzip fail or legacy numeric: extract last 4 digits
    const aadhaarLast4 = trimmed.slice(-4);
    return {
      fullName: null,
      gender: null,
      age: null,
      address: null,
      aadhaarLast4,
      isNonLatinName: false,
    };
  }

  throw new Error("Invalid or unreadable Aadhaar QR code.");
}
