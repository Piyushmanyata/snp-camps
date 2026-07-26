import {
  aadhaarLast4,
  digitsOnly,
  isValidAadhaarNumber,
} from "@/lib/aadhaar";
import { normalizePhoneE164 } from "@/lib/phone";

export type PatientFormField =
  | "campDay"
  | "aadhaar"
  | "fullName"
  | "phone"
  | "age"
  | "address"
  | "email";

export type PatientFormValues = {
  campDayId: string;
  fullName: string;
  gender: string | null;
  age: number;
  address: string | null;
  phone: string | null;
  email: string | null;
  aadhaarLast4: string | null;
};

export type PatientFormDraft = {
  campDayId: string;
  fullName: string;
  gender: string;
  age: string;
  address: string;
  phone: string;
  email: string;
  aadhaar: string;
};

export type DayLike = { id: string; is_full: boolean };

export type PatientFormValidation =
  | { ok: true; values: PatientFormValues }
  | {
      ok: false;
      field: PatientFormField;
      elementId: string;
      message: string;
    };

/**
 * Desk registration validation (#47).
 * Required: camp day, full name, age. Everything else optional.
 */
export function validatePatientForm(
  draft: PatientFormDraft,
  days: DayLike[],
): PatientFormValidation {
  if (!draft.campDayId) {
    return {
      ok: false,
      field: "campDay",
      elementId: "patient-camp-day",
      message: "Camp day chuniye — open seats wala.",
    };
  }

  const selected = days.find((d) => d.id === draft.campDayId);
  if (selected?.is_full) {
    return {
      ok: false,
      field: "campDay",
      elementId: `camp-day-${draft.campDayId}`,
      message: "Yeh din full hai. Doosra din chuniye.",
    };
  }

  if (!draft.fullName.trim()) {
    return {
      ok: false,
      field: "fullName",
      elementId: "patient-full-name",
      message: "Poora naam zaroori hai.",
    };
  }

  const ageValue = draft.age === "" ? null : Number(draft.age);
  if (
    ageValue === null ||
    !Number.isInteger(ageValue) ||
    ageValue < 0 ||
    ageValue >= 150
  ) {
    return {
      ok: false,
      field: "age",
      elementId: "patient-age",
      message: "Umar zaroori hai (0 se 149).",
    };
  }

  const phoneRaw = draft.phone.trim();
  const normalizedPhone = phoneRaw ? normalizePhoneE164(phoneRaw) : null;
  if (phoneRaw && !normalizedPhone) {
    return {
      ok: false,
      field: "phone",
      elementId: "patient-phone",
      message: "Mobile 10 digit ho, ya khali chhod do.",
    };
  }

  const aDigits = digitsOnly(draft.aadhaar);
  const last4 = aadhaarLast4(draft.aadhaar);
  if (draft.aadhaar.trim()) {
    if (aDigits.length === 12 && !isValidAadhaarNumber(aDigits)) {
      return {
        ok: false,
        field: "aadhaar",
        elementId: "patient-aadhaar",
        message: "Aadhaar galat lag raha hai. Theek karo ya field saaf karo.",
      };
    }
    if (aDigits.length > 0 && aDigits.length < 4) {
      return {
        ok: false,
        field: "aadhaar",
        elementId: "patient-aadhaar",
        message: "Aadhaar: poora 12 digit ya last 4.",
      };
    }
    if (last4.length !== 4 && aDigits.length > 0) {
      return {
        ok: false,
        field: "aadhaar",
        elementId: "patient-aadhaar",
        message: "Aadhaar: poora number ya last 4 (sirf last 4 store hota hai).",
      };
    }
  }

  if (draft.email.trim() && !/^[^\s@]+@[^\s@]+$/.test(draft.email.trim())) {
    return {
      ok: false,
      field: "email",
      elementId: "patient-email",
      message: "Email theek se likho, ya khali chhod do.",
    };
  }

  return {
    ok: true,
    values: {
      campDayId: draft.campDayId,
      fullName: draft.fullName.trim(),
      gender: draft.gender || null,
      age: ageValue,
      address: draft.address.trim() || null,
      phone: normalizedPhone?.slice(-10) || null,
      email: draft.email.trim() || null,
      aadhaarLast4: last4 || null,
    },
  };
}
