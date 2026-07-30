/**
 * Prescription sheet template.
 *
 * The letterhead (organisation names in three scripts, address, tagline, emblem
 * and artwork) is a single image so it prints identically on any machine — no
 * Devanagari or Bengali font has to exist on the printing computer. A camp that
 * is not SNP replaces that one image and the text below it.
 *
 * Everything here is per-camp and admin-editable (see admin camp settings).
 * The patient identity block, registration number and Patient QR are NOT
 * templatable — they are what makes the sheet usable at the desk.
 */

/** A ruled area the optometrist writes into by hand. */
export type PrescriptionSection = {
  /** Stable key so reordering never loses saved labels. */
  key: string;
  label: string;
  /** Rendered height in millimetres of writing space. */
  heightMm: number;
  visible?: boolean;
};

export type PrescriptionTemplate = {
  /** Public path or Storage URL of the letterhead strip. */
  letterheadUrl: string;
  /** Sponsor logo shown in the footer. Empty string hides the whole block. */
  sponsorLogoUrl: string;
  sponsorLogos: string[];
  sponsorLabel: string;
  /** Diagnosis tick-boxes across the top of the clinical area. */
  diagnosisOptions: string[];
  /** Short measurement fields printed as "Label : ................". */
  vitalsFields: string[];
  /** Ruled write-in areas, in print order. */
  sections: PrescriptionSection[];
  /** Boxed line above the glasses table. */
  operationLabel: string;
  /** Whether to print the RE/LE refraction table. */
  showGlassesTable: boolean;
  glassesTableTitle: string;
  /** Small print above the signature. */
  footerNote: string;
  signatureLabel: string;
};

/** Sikar Nagarik Parishad — matches the printed pad in EYE CLINIC.jpg. */
export const DEFAULT_PRESCRIPTION_TEMPLATE: PrescriptionTemplate = {
  letterheadUrl: "/brand/letterhead.png",
  sponsorLogoUrl: "/brand/rupa-logo.png",
  sponsorLogos: ["/brand/rupa-logo.png"],
  sponsorLabel: "Sponsorer :",
  diagnosisOptions: [
    "RE - CATARACT",
    "LE - CATARACT",
    "REFRACTION",
    "MEDICINE",
  ],
  vitalsFields: ["Blood Sugar (Random)", "BP"],
  sections: [
    { key: "remarks", label: "Remarks", heightMm: 16, visible: true },
    { key: "medicines", label: "MEDICINES", heightMm: 26, visible: true },
  ],
  operationLabel: "Operation will be done at :",
  showGlassesTable: true,
  glassesTableTitle: "PRESCRIPTION FOR GLASSES",
  footerNote:
    "SIKAR NAGARIK PARISHAD (KOLKATA) & SIKAR ZILLA WELFARE TRUST have done Eye Screening, distributed spectacles and Cataract (IOL) Operation will be done by :",
  signatureLabel: "Signature of Optometrist / Eye Surgeon",
};

const MAX_DIAGNOSIS_OPTIONS = 6;
const MAX_VITAL_FIELDS = 4;
const MAX_SECTIONS = 4;
const MAX_SECTION_HEIGHT_MM = 40;
const MAX_SECTIONS_TOTAL_HEIGHT_MM = 42;
const MAX_SHORT_TEXT = 80;
const MAX_FOOTER_TEXT = 180;

/**
 * Merge a camp's stored overrides over the default. Any missing or malformed
 * field falls back rather than throwing — a bad template must never stop a
 * patient being printed and queued at a busy desk.
 */
export function resolvePrescriptionTemplate(
  stored: unknown,
): PrescriptionTemplate {
  if (!stored || typeof stored !== "object") {
    return DEFAULT_PRESCRIPTION_TEMPLATE;
  }
  const raw = stored as Partial<Record<keyof PrescriptionTemplate, unknown>>;
  const str = (value: unknown, fallback: string, max = MAX_SHORT_TEXT) =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, max)
      : fallback;
  const strList = (value: unknown, fallback: string[], maxItems: number) =>
    Array.isArray(value) && value.every((item) => typeof item === "string")
      ? (value as string[])
          .map((item) => item.trim().slice(0, MAX_SHORT_TEXT))
          .filter(Boolean)
          .slice(0, maxItems)
      : fallback;

  const sections = Array.isArray(raw.sections)
    ? (raw.sections as unknown[])
        .filter(
          (item): item is PrescriptionSection =>
            !!item &&
            typeof item === "object" &&
            typeof (item as PrescriptionSection).key === "string" &&
            typeof (item as PrescriptionSection).label === "string",
        )
        .slice(0, MAX_SECTIONS)
        .map((item) => ({
          key: item.key.slice(0, MAX_SHORT_TEXT),
          label: item.label.trim().slice(0, MAX_SHORT_TEXT),
          visible: item.visible !== false,
          heightMm:
            typeof item.heightMm === "number" &&
            item.heightMm > 0 &&
            item.heightMm <= MAX_SECTION_HEIGHT_MM
              ? Math.round(item.heightMm)
              : 20,
        }))
    : DEFAULT_PRESCRIPTION_TEMPLATE.sections;

  let remainingHeight = MAX_SECTIONS_TOTAL_HEIGHT_MM;
  const boundedSections = sections.map((section) => {
    const heightMm = Math.min(section.heightMm, remainingHeight);
    remainingHeight -= heightMm;
    return { ...section, heightMm };
  }).filter((section) => section.heightMm > 0);

  const base = DEFAULT_PRESCRIPTION_TEMPLATE;
  return {
    letterheadUrl: str(raw.letterheadUrl, base.letterheadUrl),
    sponsorLogoUrl:
      typeof raw.sponsorLogoUrl === "string"
        ? raw.sponsorLogoUrl
        : base.sponsorLogoUrl,
    sponsorLogos: Array.isArray(raw.sponsorLogos)
      ? (raw.sponsorLogos as unknown[])
          .filter((value): value is string => typeof value === "string")
          .filter((value) =>
            /^\/api\/admin\/sponsor-assets\/[0-9a-f-]+$/i.test(value),
          )
          .slice(0, 8)
      : base.sponsorLogos,
    sponsorLabel: str(raw.sponsorLabel, base.sponsorLabel),
    diagnosisOptions: strList(
      raw.diagnosisOptions,
      base.diagnosisOptions,
      MAX_DIAGNOSIS_OPTIONS,
    ),
    vitalsFields: strList(
      raw.vitalsFields,
      base.vitalsFields,
      MAX_VITAL_FIELDS,
    ),
    sections: boundedSections.length ? boundedSections : base.sections,
    operationLabel: str(raw.operationLabel, base.operationLabel),
    showGlassesTable:
      typeof raw.showGlassesTable === "boolean"
        ? raw.showGlassesTable
        : base.showGlassesTable,
    glassesTableTitle: str(raw.glassesTableTitle, base.glassesTableTitle),
    footerNote: str(raw.footerNote, base.footerNote, MAX_FOOTER_TEXT),
    signatureLabel: str(raw.signatureLabel, base.signatureLabel),
  };
}
