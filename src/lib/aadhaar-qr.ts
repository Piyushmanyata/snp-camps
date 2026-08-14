
import { inflate, inflateRaw, ungzip } from "pako";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { normalizeGender } from "@/lib/aadhaar";
import { isNonLatinText, parseDateOfBirth } from "@/lib/aadhaar-text";

export { isNonLatinText, parseDateOfBirth };

const MAX_FIELD = 180;
const MAX_ADDRESS = 512;

const CONTROL_OR_MARKUP = new RegExp("[\\u0000-\\u001f\\u007f<>]", "g");

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
  address: string | null;
  isNonLatinName: boolean;
  source: "legacy_xml" | "secure_qr" | "unknown";
};

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

function pickAadhaarLast4(attrs: Record<string, string>): string | null {
  const keys = ["uid", "aadhaar", "aadhaarnumber", "aadhaarlast4", "u", "a"];

  for (const k of keys) {
    const raw = (attrs[k] ?? "").trim();
    if (!raw) continue;
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 12) return digits.slice(-4);
    if (digits.length === 4 && !/[a-wyz0-9]/i.test(raw.replace(/\d/g, ""))) {
      return digits;
    }
  }

  for (const raw of Object.values(attrs)) {
    if (/^\d{12}$/.test(String(raw).trim())) return String(raw).trim().slice(-4);
  }

  return null;
}

function pickWholeAddress(attrs: Record<string, string>): string | null {
  for (const k of ["address", "addr", "a", "ad"]) {
    const val = (attrs[k] ?? "").trim();
    if (val.length >= 10 && /[a-z]/i.test(val)) return val;
  }
  return null;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

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
    }
  }
  return null;
}

export function numericStringToBytes(numericStr: string): Uint8Array {
  try {
    const digits = numericStr.replace(/\D/g, "");
    if (!digits) return new Uint8Array();

    if (digits.length <= 180) {
      let big = BigInt(digits);
      const zero = BigInt(0);
      const ff = BigInt(255);
      const eight = BigInt(8);
      if (big === zero) return new Uint8Array([0]);
      const bytes: number[] = [];
      while (big > zero) {
        bytes.push(Number(big & ff));
        big = big >> eight;
      }
      bytes.reverse();
      return new Uint8Array(bytes);
    }

    const CHUNK = 9;
    const BASE = 1_000_000_000;
    const limbs: number[] = [];
    let rem = digits.length % CHUNK;
    if (rem === 0) rem = CHUNK;
    limbs.push(Number(digits.slice(0, rem)));
    for (let j = rem; j < digits.length; j += CHUNK) {
      limbs.push(Number(digits.slice(j, j + CHUNK)));
    }

    const bytes: number[] = [0];
    for (const limb of limbs) {
      let carry = 0;
      for (let i = bytes.length - 1; i >= 0; i--) {
        const product = bytes[i] * BASE + carry;
        bytes[i] = product & 0xff;
        carry = Math.floor(product / 256);
      }
      while (carry > 0) {
        bytes.unshift(carry & 0xff);
        carry = Math.floor(carry / 256);
      }
      carry = limb;
      for (let i = bytes.length - 1; i >= 0 && carry > 0; i--) {
        const sum = bytes[i] + carry;
        bytes[i] = sum & 0xff;
        carry = Math.floor(sum / 256);
      }
      while (carry > 0) {
        bytes.unshift(carry & 0xff);
        carry = Math.floor(carry / 256);
      }
    }

    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    return new Uint8Array(bytes.slice(start));
  } catch {
    return new Uint8Array();
  }
}

function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder("iso-8859-1").decode(bytes);
}

function decodeField(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeLatin1(bytes);
  }
}

function textDecodings(bytes: Uint8Array): string[] {
  const first = bytes[0];
  const looksLikeText = first === 0x3c || first === 0x7b;
  const latin1 = decodeLatin1(bytes);
  if (!looksLikeText) return [latin1];

  try {
    const utf8 = new TextDecoder("utf-8").decode(bytes);
    return utf8 === latin1 ? [latin1] : [utf8, latin1];
  } catch {
    return [latin1];
  }
}

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

  if (!parsed.address) {
    const whole = pickWholeAddress(attrs);
    if (whole) return { ...parsed, address: cleanText(whole, MAX_ADDRESS) };
  }
  return parsed;
}

function looksLikeSnpSlip(trimmed: string): boolean {
  if (trimmed.startsWith("SNP-")) return true;

  const lower = trimmed.toLowerCase();
  if (/^https?:\/\//.test(lower)) {
    return true;
  }
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

export function parseAadhaarQr(
  payload: string,
  now: Date = new Date(),
): ParsedAadhaarQr {
  if (!payload || typeof payload !== "string") throw new Error(UNREADABLE);

  const trimmed = payload.trim();

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
    }
  }

  if (looksLikeSnpSlip(trimmed)) throw new Error(DESK_SLIP);

  if (/<[a-zA-Z0-9_:-]+[^>]*>/.test(trimmed)) {
    const parsed = parseXmlPayload(trimmed, now);
    if (parsed) return parsed;
    if (trimmed.startsWith("<")) throw new Error(UNREADABLE);
  }

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
    }
  }

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

  if (/^\d{50,}$/.test(trimmed)) {
    const bytes = numericStringToBytes(trimmed);
    const parsed = parseAadhaarBytes(bytes, now);
    if (parsed) return parsed;
  }

  throw new Error(UNREADABLE);
}

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

  for (const text of textDecodings(bytes)) {
    if (text.startsWith("<") || text.startsWith("{")) {
      const parsed = tryParse(text, now);
      if (isUseful(parsed)) return parsed;
    }
  }

  const fields = splitSecureQrFields(bytes);
  const parsed = parseSecureAadhaarFields(fields, now);
  return isUseful(parsed) ? parsed : null;
}

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

export async function parseAadhaarQrAsync(
  payload: string | Uint8Array,
  now: Date = new Date(),
): Promise<ParsedAadhaarQr> {
  const candidates: Uint8Array[] = [];
  const text = typeof payload === "string" ? payload.trim() : "";

  if (payload instanceof Uint8Array) {
    candidates.push(payload);
    const digits = decodeLatin1(payload).trim();
    if (/^\d{50,}$/.test(digits)) candidates.push(numericStringToBytes(digits));
  } else if (/^\d{50,}$/.test(text)) {
    candidates.push(numericStringToBytes(text));
  }

  for (const bytes of candidates) {
    const parsed = parseAadhaarBytes(bytes, now);
    if (isUseful(parsed)) return parsed;
  }

  const last = parseAadhaarQr(
    typeof payload === "string" ? payload : decodeLatin1(payload),
    now,
  );
  if (!isUseful(last)) throw new Error(UNREADABLE);
  return last;
}

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
