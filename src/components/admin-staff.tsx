"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Input,
  Select,
  SuccessBox,
} from "@/components/ui";
import {
  StaffDetailPanel,
  type StaffPerson,
} from "@/components/staff-detail";

export type ManageableStaffRole =
  | "volunteer"
  | "team_lead"
  | "clinical_operator";

type CredentialShare = {
  id: string;
  email: string;
  password: string;
  name: string;
};

function roleCopy(role: ManageableStaffRole, fieldCopy: boolean) {
  const localized = role === "volunteer" && fieldCopy;
  const surface = localized
    ? {
        lang: "hi-Latn",
        networkError:
          "Internet nahi mila. Connection check karke dobara koshish karein.",
        responseError: (message: string | undefined, fallback: string) =>
          message && /changed during/i.test(message)
            ? "Volunteer ki jaankari beech mein badal gayi. Refresh karke dobara koshish karein."
            : fallback,
        credentialText: (
          credential: CredentialShare,
          origin: string,
          title: string,
        ) =>
          [
            title,
            `Naam: ${credential.name}`,
            `Email: ${credential.email}`,
            `Temporary password: ${credential.password}`,
            `Login: ${origin}/login`,
            "Login ke baad yeh password badlein.",
          ].join("\n"),
        credentialCopied: "Login ki jaankari copy ho gayi.",
        credentialCopyFail: "Copy nahi hua — password ko khud select karein.",
        fallbackLabel: "is volunteer",
        resetPrompt: (label: string) =>
          `${label} ka temporary password reset karein? Abhi wala password turant band ho jayega.`,
        resetOk:
          "Temporary password reset ho gaya. Neeche ek baar share karein.",
        reactivatePrompt: (label: string) =>
          `${label} ko dobara chalu karein? Woh phir se login kar payenge.`,
        reactivateOk: (label: string) => `${label} dobara chalu ho gaya.`,
        deactivatePrompt: (label: string, history: string) =>
          `${label} ko band karein? ${history}`,
        deactivateOk: (label: string) => `${label} band ho gaya.`,
        creatingStatus: "Volunteer ka account ban raha hai.",
        resettingStatus: "Volunteer ka password reset ho raha hai.",
        reactivatingStatus: "Volunteer ka account dobara chalu ho raha hai.",
        deactivatingStatus: "Volunteer ka account band ho raha hai.",
        noEmail: "email nahi",
        disabledSuffix: " · band",
        viewingSuffix: " · hisaab khula hai",
        tapSuffix: " · hisaab ke liye tap karein",
        metricLabel: "alag marij",
        roleBadge: "Volunteer ka role",
        disabledBadge: "Band",
        reactivating: "Chalu ho raha hai…",
        reactivate: "Dobara chalu karein",
        resetting: "Reset ho raha hai…",
        reset: "Password reset karein",
        deactivating: "Band ho raha hai…",
        deactivate: "Band karein",
        credentialHeading: "Temporary login share karein (sirf ek baar dikhega)",
        credentialHelp:
          "Band karne se pehle yeh jaankari copy karein. Password dobara nahi dikhega; nayi copy ke liye use reset karein.",
        passwordLabel: "Ek-baar ka password",
        copied: "Copy ho gaya",
        copyLogin: "Login ki jaankari copy karein",
        dismissPrompt:
          "Kya aapne yeh temporary password safe rakh ya share kar diya hai?",
        dismiss: "Band karein",
        createHelp:
          "Volunteer banne ke baad safe temporary password sirf ek baar dikhega. Woh Staff login se login karenge.",
        fullNameLabel: "Poora naam",
        cancel: "Radd karein",
      }
    : {
        lang: undefined,
        networkError: "Network error. Check your connection and try again.",
        responseError: (message: string | undefined, fallback: string) =>
          message || fallback,
        credentialText: (
          credential: CredentialShare,
          origin: string,
          title: string,
        ) =>
          [
            title,
            `Name: ${credential.name}`,
            `Email: ${credential.email}`,
            `Temporary password: ${credential.password}`,
            `Sign in: ${origin}/login`,
            "Change this password after signing in.",
          ].join("\n"),
        credentialCopied: "Login details copied.",
        credentialCopyFail: "Could not copy — select the password manually.",
        fallbackLabel: `this ${role}`,
        resetPrompt: (label: string) =>
          `Reset the temporary password for ${label}? Their current password will stop working immediately.`,
        resetOk: "Temporary password reset. Share it below (shown once).",
        reactivatePrompt: (label: string) =>
          `Reactivate ${label}? They will be able to sign in again.`,
        reactivateOk: (label: string) => `Reactivated ${label}.`,
        deactivatePrompt: (label: string, history: string) =>
          `Deactivate ${label}? ${history}`,
        deactivateOk: (label: string) => `Deactivated ${label}.`,
        creatingStatus: `Creating ${role} account.`,
        resettingStatus: `Resetting ${role} password.`,
        reactivatingStatus: `Reactivating ${role} account.`,
        deactivatingStatus: `Deactivating ${role} account.`,
        noEmail: "no email",
        disabledSuffix: " · disabled",
        viewingSuffix: " · viewing KPIs",
        tapSuffix: " · tap for KPIs",
        metricLabel: "distinct patients",
        roleBadge: role,
        disabledBadge: "disabled",
        reactivating: "Reactivating…",
        reactivate: "Reactivate",
        resetting: "Resetting…",
        reset: "Reset password",
        deactivating: "Deactivating…",
        deactivate: "Deactivate",
        credentialHeading: "Share temporary login (shown once)",
        credentialHelp:
          "Copy these details before dismissing them. The password cannot be retrieved again; reset it if another copy is needed.",
        passwordLabel: "Temporary password",
        copied: "Copied",
        copyLogin: "Copy login details",
        dismissPrompt:
          "Have you securely saved or shared this temporary password?",
        dismiss: "Dismiss",
        createHelp:
          "A secure temporary password is generated after creation and shown only once. They sign in at Staff login.",
        fullNameLabel: "Full name",
        cancel: "Cancel",
      };

  if (localized) {
    return {
      ...surface,
      intro:
        "Naam aur email se volunteer jodein. Share karne ke liye ek temporary password sirf ek baar dikhega.",
      empty: "Abhi koi volunteer nahi — pehla volunteer neeche jodein.",
      addButton: "Naya volunteer jodein",
      createSubmit: "Volunteer banayein aur password lein",
      createOk: "Volunteer ban gaya. Temporary password neeche ek baar share karein.",
      createFail: "Volunteer nahi ban paya. Dobara koshish karein.",
      resetFail: "Volunteer ka password reset nahi hua. Dobara koshish karein.",
      reactivateFail: "Volunteer dobara chalu nahi hua. Dobara koshish karein.",
      deactivateFail: "Volunteer band nahi hua. Dobara koshish karein.",
      credentialTitle: "SNP Camps volunteer ka login",
      defaultName: "Volunteer",
      formId: "volunteer-create-form",
      credentialHeadingId: "volunteer-credential-heading",
      detailIdPrefix: "volunteer-detail",
      historyOnDeactivate:
        "Login turant band ho jayega; pehle ka kaam safe rahega.",
      namePlaceholder: "Volunteer ka naam",
      emailPlaceholder: "volunteer@example.com",
      emailHint: "Isi email se login hoga — ise badlein nahi",
    };
  }
  if (role === "clinical_operator") {
    return {
      ...surface,
      intro: "Create a least-privilege Clinical Desk Operator account.",
      empty: "No Clinical Desk Operators yet.",
      addButton: "Add Clinical Desk Operator",
      createSubmit: "Create operator & get password",
      createOk: "Operator created. Share the temporary password once.",
      createFail: "Failed to create Clinical Desk Operator",
      resetFail: "Failed to reset operator password",
      reactivateFail: "Failed to reactivate operator",
      deactivateFail: "Failed to deactivate operator",
      credentialTitle: "SNP Camps Clinical Desk login",
      defaultName: "Clinical Desk Operator",
      formId: "clinical-operator-create-form",
      credentialHeadingId: "clinical-operator-credential-heading",
      detailIdPrefix: "clinical-operator-detail",
      historyOnDeactivate:
        "Sign-in stops immediately; attributed clinical history is preserved.",
      namePlaceholder: "Operator name",
      emailPlaceholder: "clinical@example.com",
      emailHint: "Used only for the operator's station login",
    };
  }
  if (role === "team_lead") {
    return {
      ...surface,
      intro:
        "Create a team lead with name + email. A temporary password is generated for you to share once. Tap a name for KPIs.",
      empty: "No team leads yet — add the first below.",
      addButton: "Register new team lead",
      createSubmit: "Create team lead & get password",
      createOk: "Team lead created. Share the temporary password below (shown once).",
      createFail: "Failed to create team lead",
      resetFail: "Failed to reset team lead password",
      reactivateFail: "Failed to reactivate team lead",
      deactivateFail: "Failed to deactivate team lead",
      credentialTitle: "SNP Camps team lead login",
      defaultName: "Team Lead",
      formId: "team-lead-create-form",
      credentialHeadingId: "team-lead-credential-heading",
      detailIdPrefix: "team-lead-detail",
      historyOnDeactivate:
        "They will no longer be able to sign in. Their activity history will be preserved.",
      namePlaceholder: "Team lead name",
      emailPlaceholder: "teamlead@example.com",
      emailHint: "Must stay the same — they sign in with this email",
    };
  }
  return {
    ...surface,
    intro:
      "Create a volunteer with name + email. A temporary password is generated for you to share once. Tap a name for KPIs.",
    empty: "No volunteers yet — add the first below.",
    addButton: "Register new volunteer",
    createSubmit: "Create volunteer & get password",
    createOk: "Volunteer created. Share the temporary password below (shown once).",
    createFail: "Failed to create volunteer",
    resetFail: "Failed to reset volunteer password",
    reactivateFail: "Failed to reactivate volunteer",
    deactivateFail: "Failed to deactivate volunteer",
    credentialTitle: "SNP Camps volunteer login",
    defaultName: "Volunteer",
    formId: "volunteer-create-form",
    credentialHeadingId: "volunteer-credential-heading",
    detailIdPrefix: "volunteer-detail",
    historyOnDeactivate:
      "They will no longer be able to sign in. Their activity history will be preserved.",
    namePlaceholder: "Volunteer name",
    emailPlaceholder: "volunteer@example.com",
    emailHint: "Must stay the same — they sign in with this email",
  };
}

export function AdminStaff({
  role,
  initial,
  canManage = true,
  canViewDetail = true,
  fieldCopy = false,
  teamLeadOptions,
  metricById,
}: {
  role: ManageableStaffRole;
  initial: StaffPerson[];
  canManage?: boolean;
  canViewDetail?: boolean;
  fieldCopy?: boolean;
  teamLeadOptions?: Array<{ id: string; full_name: string | null }>;
  metricById?: Record<string, number>;
}) {
  const copy = roleCopy(role, fieldCopy);
  const apiBase = `/api/admin/staff/${role}`;
  const router = useRouter();
  const [list, setList] = useState(initial);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setList(initial);
  }
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [teamLeadId, setTeamLeadId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [credential, setCredential] = useState<CredentialShare | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const credentialHeadingRef = useRef<HTMLHeadingElement>(null);
  const busy =
    loading ||
    deletingId !== null ||
    resettingId !== null ||
    reactivatingId !== null ||
    credential !== null;

  useEffect(() => {
    if (credential) credentialHeadingRef.current?.focus();
  }, [credential]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setLoading(true);
    setError(null);
    setOk(null);

    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName,
          email,
          ...(teamLeadOptions ? { teamLeadId: teamLeadId || null } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        staff?: StaffPerson;
        temporaryPassword?: string;
      };
      if (!res.ok || !json.staff || !json.temporaryPassword) {
        setError(copy.responseError(json.error, copy.createFail));
        return;
      }

      setList((prev) => [
        { ...json.staff!, phone: null, role },
        ...prev,
      ]);
      setCredential({
        id: json.staff.id,
        email: json.staff.email || email,
        password: json.temporaryPassword,
        name: json.staff.full_name || fullName,
      });
      setOk(copy.createOk);
      setFullName("");
      setEmail("");
      setTeamLeadId("");
      setShowForm(false);
      router.refresh();
    } catch {
      setError(copy.networkError);
    } finally {
      setLoading(false);
    }
  }

  async function copyCredential() {
    if (!credential) return;
    const text = copy.credentialText(
      credential,
      window.location.origin,
      copy.credentialTitle,
    );
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError(null);
      setOk(copy.credentialCopied);
    } catch {
      setCopied(false);
      setError(copy.credentialCopyFail);
    }
  }

  async function onReset(person: StaffPerson) {
    if (busy) return;
    const label = person.full_name || person.email || copy.fallbackLabel;
    if (!window.confirm(copy.resetPrompt(label))) {
      return;
    }

    setResettingId(person.id);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(apiBase, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: person.id, action: "reset_password" }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        temporaryPassword?: string;
        staff?: Pick<StaffPerson, "id" | "full_name" | "email">;
      };
      if (!res.ok || !json.temporaryPassword) {
        setError(copy.responseError(json.error, copy.resetFail));
        return;
      }

      setCredential({
        id: person.id,
        email: json.staff?.email || person.email || "",
        password: json.temporaryPassword,
        name: json.staff?.full_name || person.full_name || copy.defaultName,
      });
      setOk(copy.resetOk);
    } catch {
      setError(copy.networkError);
    } finally {
      setResettingId(null);
    }
  }

  async function onReactivate(person: StaffPerson) {
    if (busy || !person.disabled_at) return;
    const label = person.full_name || person.email || copy.fallbackLabel;
    if (!window.confirm(copy.reactivatePrompt(label))) {
      return;
    }

    setReactivatingId(person.id);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(apiBase, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: person.id, action: "reactivate" }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        staff?: StaffPerson;
      };
      if (!res.ok || !json.staff) {
        setError(copy.responseError(json.error, copy.reactivateFail));
        return;
      }
      setList((prev) =>
        prev.map((row) =>
          row.id === person.id
            ? { ...row, ...json.staff, disabled_at: null }
            : row,
        ),
      );
      setOk(copy.reactivateOk(label));
      router.refresh();
    } catch {
      setError(copy.networkError);
    } finally {
      setReactivatingId(null);
    }
  }

  async function onDelete(person: StaffPerson) {
    if (busy) return;
    const label = person.full_name || person.email || copy.fallbackLabel;
    if (!window.confirm(copy.deactivatePrompt(label, copy.historyOnDeactivate))) {
      return;
    }
    setDeletingId(person.id);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(
        `${apiBase}?id=${encodeURIComponent(person.id)}`,
        { method: "DELETE" },
      );
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        disabledAt?: string;
      };
      if (!res.ok) {
        setError(copy.responseError(json.error, copy.deactivateFail));
        return;
      }
      setList((prev) =>
        prev.map((row) =>
          row.id === person.id
            ? {
                ...row,
                disabled_at: json.disabledAt || new Date().toISOString(),
              }
            : row,
        ),
      );
      if (selectedId === person.id) setSelectedId(null);
      setOk(copy.deactivateOk(label));
      router.refresh();
    } catch {
      setError(copy.networkError);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div lang={copy.lang} className="space-y-3">
      <p className="text-sm text-muted">
        {canViewDetail
          ? copy.intro
          : copy.intro.replace(/\s*Tap a [a-z ]+ for KPIs\.?/i, "")}
      </p>
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {loading
          ? copy.creatingStatus
          : resettingId
            ? copy.resettingStatus
            : reactivatingId
              ? copy.reactivatingStatus
              : deletingId
                ? copy.deactivatingStatus
                : ""}
      </p>
      <ErrorBox message={error} />
      <SuccessBox message={ok} />
      <ul className="divide-y divide-border rounded-xl border border-border bg-white">
        {list.map((person) => {
          const open = selectedId === person.id;
          const detailId = `${copy.detailIdPrefix}-${person.id}`;
          return (
            <li key={person.id}>
              <div className="flex flex-col items-stretch gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
                {canViewDetail ? (
                  <button
                    id={`staff-detail-trigger-${person.id}`}
                    type="button"
                    onClick={() => setSelectedId(open ? null : person.id)}
                    aria-expanded={open}
                    aria-controls={detailId}
                    className="pressable inline-flex min-h-12 min-w-0 flex-1 items-center rounded-lg px-3 py-2 text-left transition focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  >
                    <p className="truncate font-medium text-foreground">
                      {person.full_name || "—"}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {person.email || copy.noEmail}
                      {person.disabled_at
                        ? copy.disabledSuffix
                        : open
                          ? copy.viewingSuffix
                          : copy.tapSuffix}
                    </p>
                  </button>
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">
                      {person.full_name || "—"}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {person.email || copy.noEmail}
                      {person.disabled_at ? copy.disabledSuffix : ""}
                    </p>
                  </div>
                )}
                <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto">
                  {metricById ? (
                    <Badge>
                      {metricById[person.id] ?? 0} {copy.metricLabel}
                    </Badge>
                  ) : null}
                  <Badge tone="ok">{copy.roleBadge}</Badge>
                  {person.disabled_at ? (
                    <Badge tone="danger">{copy.disabledBadge}</Badge>
                  ) : null}
                  {canManage ? (
                    person.disabled_at ? (
                      <button
                        type="button"
                        disabled={busy}
                        aria-busy={
                          reactivatingId === person.id || undefined
                        }
                        onClick={() => void onReactivate(person)}
                        className="pressable min-h-12 min-w-12 rounded-lg border border-brand/25 bg-brand-soft px-3 py-2 text-sm font-semibold text-brand transition hover:bg-white disabled:opacity-50"
                      >
                        {reactivatingId === person.id
                          ? copy.reactivating
                          : copy.reactivate}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          aria-busy={
                            resettingId === person.id || undefined
                          }
                          onClick={() => void onReset(person)}
                          className="pressable min-h-12 min-w-12 rounded-lg border border-border bg-brand-soft px-3 py-2 text-sm font-semibold text-brand transition hover:bg-white disabled:opacity-50"
                        >
                          {resettingId === person.id
                            ? copy.resetting
                            : copy.reset}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          aria-busy={deletingId === person.id || undefined}
                          onClick={() => void onDelete(person)}
                          className="pressable min-h-12 min-w-12 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-sm font-semibold text-danger transition hover:bg-danger/10 disabled:opacity-50"
                        >
                          {deletingId === person.id
                            ? copy.deactivating
                            : copy.deactivate}
                        </button>
                      </>
                    )
                  ) : null}
                </div>
              </div>
              {open && role !== "clinical_operator" ? (
                <div id={detailId} className="px-3 pb-3">
                  <StaffDetailPanel
                    person={person}
                    role={role}
                    onClose={() => setSelectedId(null)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
        {!list.length ? (
          <li className="px-3 py-3">
            <EmptyState>{copy.empty}</EmptyState>
          </li>
        ) : null}
      </ul>

      {credential ? (
        <section
          aria-labelledby={copy.credentialHeadingId}
          className="rounded-2xl border border-brand/25 bg-brand-soft/40 p-4"
        >
          <h3
            id={copy.credentialHeadingId}
            ref={credentialHeadingRef}
            tabIndex={-1}
            className="text-sm font-bold text-brand"
          >
            {copy.credentialHeading}
          </h3>
          <p className="mt-1 text-xs text-muted">
            {copy.credentialHelp}
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted">Email</dt>
              <dd className="break-all font-semibold">{credential.email}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted">
                {copy.passwordLabel}
              </dt>
              <dd className="break-all font-mono font-bold tracking-wide text-brand">
                {credential.password}
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              className="sm:w-auto"
              onClick={() => void copyCredential()}
            >
              {copied ? copy.copied : copy.copyLogin}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="sm:w-auto"
              onClick={() => {
                if (
                  window.confirm(
                    copy.dismissPrompt,
                  )
                ) {
                  setCredential(null);
                  setCopied(false);
                }
              }}
            >
              {copy.dismiss}
            </Button>
          </div>
        </section>
      ) : null}

      {canManage ? (
        <div className="border-t border-border pt-3">
          {!showForm ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              aria-expanded={showForm}
              aria-controls={copy.formId}
              onClick={() => {
                setShowForm(true);
                setError(null);
                setOk(null);
              }}
            >
              {copy.addButton}
            </Button>
          ) : (
            <form id={copy.formId} onSubmit={onSubmit} className="space-y-3">
              <p className="text-sm text-muted">
                {copy.createHelp}
              </p>
              <Input
                label={copy.fullNameLabel}
                required
                disabled={busy}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder={copy.namePlaceholder}
              />
              <Input
                label="Email"
                type="email"
                required
                disabled={busy}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={copy.emailPlaceholder}
                hint={copy.emailHint}
              />
              {teamLeadOptions ? (
                <Select
                  label="Team Lead"
                  value={teamLeadId}
                  disabled={busy}
                  onChange={(event) => setTeamLeadId(event.target.value)}
                  hint="Optional — leave unassigned if this volunteer has no team yet."
                >
                  <option value="">Unassigned</option>
                  {teamLeadOptions.map((lead) => (
                    <option key={lead.id} value={lead.id}>
                      {lead.full_name || "Team Lead"}
                    </option>
                  ))}
                </Select>
              ) : null}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="submit"
                  loading={loading}
                  disabled={busy}
                  variant="secondary"
                >
                  {copy.createSubmit}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setShowForm(false);
                    setError(null);
                  }}
                >
                  {copy.cancel}
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
