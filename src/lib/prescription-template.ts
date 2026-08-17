
export type PrescriptionSection = {
  key: string;
  label: string;
  heightMm: number;
  visible?: boolean;
};

export type PrescriptionTemplate = {
  letterheadUrl: string;
  sponsorLogoUrl: string;
  sponsorLogos: string[];
  sponsorLabel: string;
  diagnosisOptions: string[];
  vitalsFields: string[];
  sections: PrescriptionSection[];
  operationLabel: string;
  showGlassesTable: boolean;
  glassesTableTitle: string;
  footerNote: string;
  signatureLabel: string;
};

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

const graphemes = new Intl.Segmenter("hi", { granularity: "grapheme" });

// slice() cuts UTF-16 code units, printing a broken Devanagari glyph on the
// paper record when the cap lands mid-cluster.
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = "";
  for (const { segment } of graphemes.segment(value)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out;
}

export function resolvePrescriptionTemplate(
  stored: unknown,
): PrescriptionTemplate {
  if (!stored || typeof stored !== "object") {
    return DEFAULT_PRESCRIPTION_TEMPLATE;
  }
  const raw = stored as Partial<Record<keyof PrescriptionTemplate, unknown>>;
  const str = (value: unknown, fallback: string, max = MAX_SHORT_TEXT) =>
    typeof value === "string" && value.trim() ? clip(value.trim(), max) : fallback;
  const strList = (value: unknown, fallback: string[], maxItems: number) =>
    Array.isArray(value) && value.every((item) => typeof item === "string")
      ? (value as string[])
          .map((item) => clip(item.trim(), MAX_SHORT_TEXT))
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
    if (section.visible === false) return section;
    const heightMm = Math.min(section.heightMm, remainingHeight);
    remainingHeight -= heightMm;
    return { ...section, heightMm };
  }).filter((section) => section.heightMm > 0);

  const base = DEFAULT_PRESCRIPTION_TEMPLATE;
  const isAllowedAssetUrl = (value: string) =>
    value === "/brand/letterhead.png" ||
    value === "/brand/rupa-logo.png" ||
    /^\/brand\/[a-z0-9._-]+\.(png|jpe?g|webp|svg)$/i.test(value) ||
    /^\/api\/admin\/sponsor-assets\/[0-9a-f-]+$/i.test(value);

  const letterheadCandidate =
    typeof raw.letterheadUrl === "string" ? raw.letterheadUrl.trim() : "";
  const sponsorCandidate =
    typeof raw.sponsorLogoUrl === "string" ? raw.sponsorLogoUrl.trim() : "";

  return {
    letterheadUrl: isAllowedAssetUrl(letterheadCandidate)
      ? letterheadCandidate
      : base.letterheadUrl,
    sponsorLogoUrl: isAllowedAssetUrl(sponsorCandidate)
      ? sponsorCandidate
      : base.sponsorLogoUrl,
    sponsorLogos: Array.isArray(raw.sponsorLogos)
      ? (raw.sponsorLogos as unknown[])
          .filter((value): value is string => typeof value === "string")
          .filter(isAllowedAssetUrl)
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
