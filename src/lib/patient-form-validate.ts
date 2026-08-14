import {
  aadhaarLast4,
  digitsOnly,
  isValidAadhaarNumber,
} from "@/lib/aadhaar";
import { validateHouseholdPhone } from "@/lib/phone";

export type PatientFormField =
  | "campDay"
  | "aadhaar"
  | "fullName"
  | "displayName"
  | "phone"
  | "age"
  | "address"
  | "email";

export type PatientFormValues = {
  campDayId: string;
  fullName: string;
  displayName: string | null;
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
  displayName?: string;
  gender: string;
  age: string;
  address: string;
  phone: string;
  email: string;
  aadhaar: string;
};

export type DayLike = {
  id: string;
  is_full: boolean;
  day_date?: string;
};

export type PatientFormValidation =
  | { ok: true; values: PatientFormValues }
  | {
      ok: false;
      field: PatientFormField;
      elementId: string;
      message: string;
    };

export function kolkataTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isDeskDaySelectable(
  day: DayLike,
  todayIso: string = kolkataTodayIso(),
): boolean {
  if (day.day_date && day.day_date === todayIso) return true;
  return !day.is_full;
}

export function validatePatientForm(
  draft: PatientFormDraft,
  days: DayLike[],
  options: { todayIso?: string } = {},
): PatientFormValidation {
  const todayIso = options.todayIso ?? kolkataTodayIso();

  if (!draft.campDayId) {
    return {
      ok: false,
      field: "campDay",
      elementId: "patient-camp-day",
      message: "Select a camp day.",
    };
  }

  const selected = days.find((d) => d.id === draft.campDayId);
  if (selected && !isDeskDaySelectable(selected, todayIso)) {
    return {
      ok: false,
      field: "campDay",
      elementId: `camp-day-${draft.campDayId}`,
      message: "This day is full. Select another day.",
    };
  }

  if (!draft.fullName.trim()) {
    return {
      ok: false,
      field: "fullName",
      elementId: "patient-full-name",
      message: "Full name is required.",
    };
  }

  // Devanagari / non-Latin scanned name requires a Latin display name (#112)
  const isNonLatinName = /[^\u0000-\u007F\u00A0-\u024F\s\.,'-]/u.test(draft.fullName);
  const trimmedDisplayName = draft.displayName?.trim() || "";
  if (isNonLatinName) {
    if (!trimmedDisplayName) {
      return {
        ok: false,
        field: "displayName",
        elementId: "patient-display-name",
        message: "Scanned name is in Devanagari/non-Latin. Please enter a Latin display name.",
      };
    }
    const isNonLatinDisplay = /[^\u0000-\u007F\u00A0-\u024F\s\.,'-]/u.test(trimmedDisplayName);
    if (isNonLatinDisplay) {
      return {
        ok: false,
        field: "displayName",
        elementId: "patient-display-name",
        message: "Display name must be in Latin script.",
      };
    }
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
      message: "Age is required (0–149).",
    };
  }

  const phoneResult = validateHouseholdPhone(draft.phone);
  if (!phoneResult.ok) {
    return {
      ok: false,
      field: "phone",
      elementId: "patient-phone",
      message: phoneResult.message,
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
        message: "Aadhaar looks invalid. Correct it or clear the field.",
      };
    }
    if (aDigits.length > 0 && aDigits.length < 4) {
      return {
        ok: false,
        field: "aadhaar",
        elementId: "patient-aadhaar",
        message: "Enter the full 12-digit Aadhaar or the last 4 digits.",
      };
    }
    if (last4.length !== 4 && aDigits.length > 0) {
      return {
        ok: false,
        field: "aadhaar",
        elementId: "patient-aadhaar",
        message: "Enter the full Aadhaar number or last 4 (only last 4 is stored).",
      };
    }
  }

  if (draft.email.trim() && !/^[^\s@]+@[^\s@]+$/.test(draft.email.trim())) {
    return {
      ok: false,
      field: "email",
      elementId: "patient-email",
      message: "Enter a valid email, or leave it blank.",
    };
  }

  return {
    ok: true,
    values: {
      campDayId: draft.campDayId,
      fullName: draft.fullName.trim(),
      displayName: trimmedDisplayName || null,
      gender: draft.gender || null,
      age: ageValue,
      address: draft.address.trim() || null,
      phone: phoneResult.phone,
      email: draft.email.trim() || null,
      aadhaarLast4: last4 || null,
    },
  };
}
