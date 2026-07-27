/**
 * Pure function Aadhaar QR payload decoder (#92).
 * Parses XML (<PrintLetterBarcodeData ...>) and secure/numeric/JSON Aadhaar QR payloads.
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
  // Non-Latin characters outside standard ASCII & Latin-1 / Latin Extended-A/B ranges
  return /[^\u0000-\u007F\u00A0-\u024F\s\.,'-]/u.test(text);
}

/**
 * Calculate age accurately from DOB string (YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD)
 * or YOB string (YYYY), considering the current reference date.
 */
export function calculateAge(
  dobStr?: string | null,
  yobStr?: string | null,
  now: Date = new Date(),
): number | null {
  if (dobStr && typeof dobStr === "string") {
    const trimmed = dobStr.trim();
    let year: number | null = null;
    let month: number | null = null;
    let day: number | null = null;

    // Format: YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    // Format: DD-MM-YYYY or DD/MM/YYYY
    const dmyMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);

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
      const currentMonth = now.getMonth() + 1; // 1-indexed
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

  if (yobStr && typeof yobStr === "string") {
    const yob = parseInt(yobStr.trim(), 10);
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
  if (trimmed.includes("PrintLetterBarcodeData") || (trimmed.startsWith("<") && trimmed.endsWith(">"))) {
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_]+)="([^"]*)"/g;
    let match: RegExpExecArray | null;

    while ((match = attrRegex.exec(trimmed)) !== null) {
      attrs[match[1].toLowerCase()] = match[2];
    }

    const uid = attrs["uid"] || attrs["aadhaar"] || "";
    const name = attrs["name"] || attrs["fullname"] || null;
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
      const name = obj.name || obj.fullName || null;
      const gnd = obj.gender || obj.gnd || null;
      const dob = obj.dob || null;
      const yob = obj.yob || null;
      const uid = String(obj.uid || obj.aadhaar || obj.aadhaarLast4 || "");
      const aadhaarLast4 = uid.replace(/\D/g, "").slice(-4) || null;

      const age = calculateAge(dob, yob, now);
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

  // 5. Parse Secure Aadhaar QR / Numeric strings (BigInt decimal sequence or delimited text)
  if (/^\d{50,}$/.test(trimmed)) {
    // Large decimal number sequence from Secure QR
    // Extract last 4 if UID present or basic fields
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
