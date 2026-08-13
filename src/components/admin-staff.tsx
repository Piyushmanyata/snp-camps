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

function roleCopy(role: ManageableStaffRole) {
  if (role === "clinical_operator") {
    return {
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
  teamLeadOptions,
  metricById,
}: {
  role: ManageableStaffRole;
  initial: StaffPerson[];
  /** Create, reset, deactivate, and reactivate accounts */
  canManage?: boolean;
  /**
   * Expand a row for per-patient KPIs. The staff-detail route and the
   * `staff_person_kpis` RPC both allow this only for an admin, or for someone
   * reading their own numbers — so a team lead managing their team passes false
   * rather than being offered a control that returns 403.
   */
  canViewDetail?: boolean;
  /** Admin-only optional team assignment when creating a volunteer. */
  teamLeadOptions?: Array<{ id: string; full_name: string | null }>;
  /** Optional aggregate shown beside each staff row. */
  metricById?: Record<string, number>;
}) {
  const copy = roleCopy(role);
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
        setError(json.error || copy.createFail);
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
      setError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function copyCredential() {
    if (!credential) return;
    const text = [
      copy.credentialTitle,
      `Name: ${credential.name}`,
      `Email: ${credential.email}`,
      `Temporary password: ${credential.password}`,
      `Sign in: ${window.location.origin}/login`,
      "Change this password after signing in.",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError(null);
      setOk("Login details copied.");
    } catch {
      setCopied(false);
      setError("Could not copy — select the password manually.");
    }
  }

  async function onReset(person: StaffPerson) {
    if (busy) return;
    const label = person.full_name || person.email || `this ${role}`;
    if (
      !window.confirm(
        `Reset the temporary password for ${label}? Their current password will stop working immediately.`,
      )
    ) {
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
        setError(json.error || copy.resetFail);
        return;
      }

      setCredential({
        id: person.id,
        email: json.staff?.email || person.email || "",
        password: json.temporaryPassword,
        name: json.staff?.full_name || person.full_name || copy.defaultName,
      });
      setOk("Temporary password reset. Share it below (shown once).");
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setResettingId(null);
    }
  }

  async function onReactivate(person: StaffPerson) {
    if (busy || !person.disabled_at) return;
    const label = person.full_name || person.email || `this ${role}`;
    if (
      !window.confirm(`Reactivate ${label}? They will be able to sign in again.`)
    ) {
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
        setError(json.error || copy.reactivateFail);
        return;
      }
      setList((prev) =>
        prev.map((row) =>
          row.id === person.id
            ? { ...row, ...json.staff, disabled_at: null }
            : row,
        ),
      );
      setOk(`Reactivated ${label}.`);
      router.refresh();
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setReactivatingId(null);
    }
  }

  async function onDelete(person: StaffPerson) {
    if (busy) return;
    const label = person.full_name || person.email || `this ${role}`;
    if (
      !window.confirm(`Deactivate ${label}? ${copy.historyOnDeactivate}`)
    ) {
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
        setError(json.error || copy.deactivateFail);
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
      setOk(`Deactivated ${label}.`);
      router.refresh();
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-3">
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
          ? `Creating ${role} account.`
          : resettingId
            ? `Resetting ${role} password.`
            : reactivatingId
              ? `Reactivating ${role} account.`
              : deletingId
                ? `Deactivating ${role} account.`
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
                      {person.email || "no email"}
                      {person.disabled_at
                        ? " · disabled"
                        : open
                          ? " · viewing KPIs"
                          : " · tap for KPIs"}
                    </p>
                  </button>
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">
                      {person.full_name || "—"}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {person.email || "no email"}
                      {person.disabled_at ? " · disabled" : ""}
                    </p>
                  </div>
                )}
                <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto">
                  {metricById ? (
                    <Badge>
                      {metricById[person.id] ?? 0} distinct patients
                    </Badge>
                  ) : null}
                  <Badge tone="ok">{role}</Badge>
                  {person.disabled_at ? (
                    <Badge tone="danger">disabled</Badge>
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
                          ? "Reactivating…"
                          : "Reactivate"}
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
                            ? "Resetting…"
                            : "Reset password"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          aria-busy={deletingId === person.id || undefined}
                          onClick={() => void onDelete(person)}
                          className="pressable min-h-12 min-w-12 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-sm font-semibold text-danger transition hover:bg-danger/10 disabled:opacity-50"
                        >
                          {deletingId === person.id
                            ? "Deactivating…"
                            : "Deactivate"}
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
            Share temporary login (shown once)
          </h3>
          <p className="mt-1 text-xs text-muted">
            Copy these details before dismissing them. The password cannot be
            retrieved again; reset it if another copy is needed.
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted">Email</dt>
              <dd className="break-all font-semibold">{credential.email}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted">Temporary password</dt>
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
              {copied ? "Copied" : "Copy login details"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="sm:w-auto"
              onClick={() => {
                if (
                  window.confirm(
                    "Have you securely saved or shared this temporary password?",
                  )
                ) {
                  setCredential(null);
                  setCopied(false);
                }
              }}
            >
              Dismiss
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
                A secure temporary password is generated after creation and
                shown only once. They sign in at <strong>Staff login</strong>.
              </p>
              <Input
                label="Full name"
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
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
