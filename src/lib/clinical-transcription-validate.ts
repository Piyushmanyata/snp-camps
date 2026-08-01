export type ClinicalFieldError = { field: string; message: string };

type ClinicalValidation = { ok: true } | { ok: false; errors: ClinicalFieldError[] };

const numeric = /^-?[0-9]+([.][0-9]+)?$/;
const nonNegativeNumeric = /^[0-9]+([.][0-9]+)?$/;

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function add(
  errors: ClinicalFieldError[],
  field: string,
  message: string,
) {
  errors.push({ field, message });
}

export function validateClinicalTranscription(
  data: Record<string, unknown>,
): ClinicalValidation {
  const errors: ClinicalFieldError[] = [];
  let encoded = "";
  try {
    encoded = JSON.stringify(data);
  } catch {
    add(errors, "data", "Clinical data must be valid JSON.");
  }
  if (encoded && new TextEncoder().encode(encoded).byteLength > 32768) {
    add(errors, "data", "Clinical data is too large.");
  }

  const diagnoses = data.diagnoses;
  if (
    !Array.isArray(diagnoses) ||
    diagnoses.length < 1 ||
    diagnoses.length > 12 ||
    diagnoses.some(
      (diagnosis) =>
        typeof diagnosis !== "string" ||
        diagnosis.trim().length < 1 ||
        diagnosis.trim().length > 120,
    )
  ) {
    add(errors, "diagnoses", "Select 1–12 diagnoses, each 1–120 characters.");
  }

  for (const field of ["remarks", "medicines"] as const) {
    if (stringValue(data[field]).length > 2000) {
      add(errors, field, "Use 2,000 characters or fewer.");
    }
  }
  for (const field of ["bloodSugar", "bloodPressure"] as const) {
    if (stringValue(data[field]).length > 32) {
      add(errors, field, "Use 32 characters or fewer.");
    }
  }

  const bloodSugar = stringValue(data.bloodSugar).trim();
  if (
    bloodSugar &&
    (!nonNegativeNumeric.test(bloodSugar) ||
      Number(bloodSugar) < 20 ||
      Number(bloodSugar) > 1000)
  ) {
    add(errors, "bloodSugar", "Enter blood sugar as a number from 20 to 1000 mg/dL.");
  }

  const bloodPressure = stringValue(data.bloodPressure).trim();
  const bloodPressureParts = bloodPressure.split("/");
  if (
    bloodPressure &&
    (!/^[0-9]{2,3}\/[0-9]{2,3}$/.test(bloodPressure) ||
      Number(bloodPressureParts[0]) < 40 ||
      Number(bloodPressureParts[0]) > 300 ||
      Number(bloodPressureParts[1]) < 30 ||
      Number(bloodPressureParts[1]) > 200)
  ) {
    add(errors, "bloodPressure", "Enter blood pressure as systolic/diastolic, within 40–300/30–200.");
  }

  const specs = data.specs;
  if (specs !== null && specs !== undefined) {
    if (!specs || typeof specs !== "object" || Array.isArray(specs)) {
      add(errors, "specs", "Enter valid Specs type, both eyes, and PD.");
    } else {
      const value = specs as Record<string, unknown>;
      const type = stringValue(value.type);
      if (!["distance", "near", "bifocal", "progressive", "fixed_power"].includes(type)) {
        add(errors, "specs.type", "Select a valid spectacle type.");
      }
      const eyes = ["right", "left"] as const;
      for (const side of eyes) {
        const eye = value[side];
        if (!eye || typeof eye !== "object" || Array.isArray(eye)) {
          add(errors, `specs.${side}`, "Enter both eye measurements.");
          continue;
        }
        const eyeData = eye as Record<string, unknown>;
        const sphere = stringValue(eyeData.sphere);
        if (!nonNegativeNumeric.test(sphere) && !numeric.test(sphere)) {
          add(errors, `specs.${side}.sphere`, "Enter a numeric sphere value.");
        }
        for (const field of ["sphere", "cylinder", "near", "nearAddition"] as const) {
          const fieldValue = stringValue(eyeData[field]).trim();
          if (
            fieldValue &&
            (!numeric.test(fieldValue) || Number(fieldValue) < -30 || Number(fieldValue) > 30)
          ) {
            add(errors, `specs.${side}.${field}`, "Use a number from −30 to 30.");
          }
        }
        const axis = stringValue(eyeData.axis).trim();
        if (axis && (!/^[0-9]+$/.test(axis) || Number(axis) < 0 || Number(axis) > 180)) {
          add(errors, `specs.${side}.axis`, "Use an axis from 0 to 180.");
        }
        if (stringValue(eyeData.vision).length > 32) {
          add(errors, `specs.${side}.vision`, "Use 32 characters or fewer.");
        }
      }
      const pd = stringValue(value.pd).trim();
      if (!nonNegativeNumeric.test(pd) || Number(pd) < 30 || Number(pd) > 80) {
        add(errors, "specs.pd", "Enter PD as a number from 30 to 80 mm.");
      }
    }
  }

  const ot = data.ot;
  if (ot !== null && ot !== undefined) {
    if (!ot || typeof ot !== "object" || Array.isArray(ot)) {
      add(errors, "ot", "Enter a valid OT eye and procedure.");
    } else {
      const value = ot as Record<string, unknown>;
      if (!["right", "left", "both"].includes(stringValue(value.eye))) {
        add(errors, "ot.eye", "Select right, left, or both eyes.");
      }
      const procedure = stringValue(value.procedure).trim();
      if (procedure.length < 1 || procedure.length > 200) {
        add(errors, "ot.procedure", "Enter an OT procedure from 1 to 200 characters.");
      }
      if (stringValue(value.notes).length > 1000) {
        add(errors, "ot.notes", "Use 1,000 characters or fewer.");
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortKeys(child)]),
  );
}

export function isSameTranscription(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
