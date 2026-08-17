import { isNonLatinText } from "./aadhaar-text";

export type CardIdentityFields = {
  fullName: string;
  dateOfBirth: string;
  gender: string;
  aadhaarLast4: string;
  address: string;
  displayName?: string;
};

const FIELDS = [
  "fullName",
  "dateOfBirth",
  "gender",
  "aadhaarLast4",
  "address",
] as const;

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

export function diffTypedVsCard(
  typed: CardIdentityFields,
  card: CardIdentityFields,
): {
  changed: Array<(typeof FIELDS)[number]>;
  typed: CardIdentityFields;
  card: CardIdentityFields;
  promoteDisplayName: boolean;
  displayName: string;
} {
  const changed = FIELDS.filter(
    (field) => norm(typed[field]) !== norm(card[field]),
  );
  const promoteDisplayName = isNonLatinText(card.fullName);
  const displayName = promoteDisplayName
    ? norm(typed.displayName) || norm(typed.fullName)
    : norm(card.displayName) || norm(card.fullName);
  return { changed, typed, card, promoteDisplayName, displayName };
}
