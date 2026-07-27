"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Input,
  SectionTitle,
} from "@/components/ui";
import type { Camp } from "@/lib/types";
import {
  MAX_SMS_VENUE_LENGTH,
  updateCampSettings,
  validateVenueLength,
} from "@/lib/admin-settings";
import { mapDbError } from "@/lib/public-error";

export function AdminSettingsPanel({ camp }: { camp: Camp }) {
  const router = useRouter();
  const [specDate, setSpecDate] = useState(
    camp.spectacles_collection_date || ""
  );
  const [specVenue, setSpecVenue] = useState(
    camp.spectacles_collection_venue || ""
  );
  const [surgDate, setSurgDate] = useState(camp.post_camp_surgery_date || "");
  const [surgVenue, setSurgVenue] = useState(
    camp.post_camp_surgery_venue || ""
  );
  const [paperFallback, setPaperFallback] = useState(
    Boolean(camp.paper_fallback_mode)
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const specVenueValid = validateVenueLength(specVenue);
  const surgVenueValid = validateVenueLength(surgVenue);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (!specVenueValid) {
      setError(
        `Spectacles collection venue exceeds maximum of ${MAX_SMS_VENUE_LENGTH} characters.`
      );
      return;
    }

    if (!surgVenueValid) {
      setError(
        `Post-camp surgery venue exceeds maximum of ${MAX_SMS_VENUE_LENGTH} characters.`
      );
      return;
    }

    setSaving(true);
    try {
      await updateCampSettings(camp.id, {
        spectaclesCollectionDate: specDate || null,
        spectaclesCollectionVenue: specVenue || null,
        postCampSurgeryDate: surgDate || null,
        postCampSurgeryVenue: surgVenue || null,
        paperFallbackMode: paperFallback,
      });

      setSuccess(true);
      router.refresh();
    } catch (err) {
      setError(
        mapDbError(err, {
          context: "admin-settings.save",
          fallback: "Could not save camp settings. Please try again.",
        })
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="!p-4 sm:!p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border pb-3">
        <div>
          <SectionTitle hint={`Camp: ${camp.name}`}>
            Camp Admin Settings
          </SectionTitle>
          <p className="text-xs text-muted">
            Configure spectacles collection, post-camp surgery, and registration
            print mode.
          </p>
        </div>
        <div>
          {paperFallback ? (
            <Badge tone="wait">Prescription Sheet</Badge>
          ) : (
            <Badge tone="ok">Desk Slip</Badge>
          )}
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-5">
        {/* Spectacles Collection Section */}
        <div className="space-y-3 rounded-lg border border-border/80 bg-background/50 p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">
              Spectacles Collection
            </h3>
            <span className="text-xs text-muted">
              {camp.spectacles_collection_date || camp.spectacles_collection_venue
                ? "Configured"
                : "Not set (Unset)"}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              id="spec-collection-date"
              label="Collection Date"
              type="date"
              value={specDate}
              onChange={(e) => setSpecDate(e.target.value)}
              hint={specDate ? `Selected: ${specDate}` : "Unset (default)"}
            />
            <div>
              <Input
                id="spec-collection-venue"
                label="Collection Venue"
                type="text"
                value={specVenue}
                onChange={(e) => setSpecVenue(e.target.value)}
                placeholder="e.g. Local District Office"
                hint={`${specVenue.length}/${MAX_SMS_VENUE_LENGTH} characters max`}
              />
              {!specVenueValid && (
                <p className="mt-1 text-xs text-danger font-medium">
                  Exceeds SMS max length ({MAX_SMS_VENUE_LENGTH} chars)
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Post-Camp Surgery Section */}
        <div className="space-y-3 rounded-lg border border-border/80 bg-background/50 p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">
              Post-Camp Surgery
            </h3>
            <span className="text-xs text-muted">
              {camp.post_camp_surgery_date || camp.post_camp_surgery_venue
                ? "Configured"
                : "Not set (Unset)"}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              id="post-surgery-date"
              label="Surgery Date"
              type="date"
              value={surgDate}
              onChange={(e) => setSurgDate(e.target.value)}
              hint={surgDate ? `Selected: ${surgDate}` : "Unset (default)"}
            />
            <div>
              <Input
                id="post-surgery-venue"
                label="Surgery Venue / Hospital"
                type="text"
                value={surgVenue}
                onChange={(e) => setSurgVenue(e.target.value)}
                placeholder="e.g. City Eye Hospital"
                hint={`${surgVenue.length}/${MAX_SMS_VENUE_LENGTH} characters max`}
              />
              {!surgVenueValid && (
                <p className="mt-1 text-xs text-danger font-medium">
                  Exceeds SMS max length ({MAX_SMS_VENUE_LENGTH} chars)
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Registration print mode (#108) — reuses paper_fallback_mode column */}
        <div className="rounded-lg border border-border/80 bg-background/50 p-3 sm:p-4 space-y-3">
          <div className="space-y-0.5">
            <p className="text-sm font-semibold text-foreground">
              Registration print mode
            </p>
            <p className="text-xs text-muted">
              What the desk prints when a volunteer uses Register &amp; print.
              Admin-only. Desk Slip is the default for all camps.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="flex min-h-12 flex-1 cursor-pointer items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-semibold has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
              <input
                type="radio"
                name="registration-print-mode"
                checked={!paperFallback}
                onChange={() => setPaperFallback(false)}
                className="h-4 w-4 accent-brand"
              />
              Desk Slip
            </label>
            <label className="flex min-h-12 flex-1 cursor-pointer items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-semibold has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
              <input
                type="radio"
                name="registration-print-mode"
                checked={paperFallback}
                onChange={() => setPaperFallback(true)}
                className="h-4 w-4 accent-brand"
                data-testid="print-mode-prescription-sheet"
              />
              Prescription Sheet
            </label>
          </div>
          {paperFallback ? (
            <p className="text-xs text-muted">
              Blank form with Patient QR and ruled space for handwritten
              diagnosis, medicines and advice. Not the doctor&apos;s completed
              prescription printout.
            </p>
          ) : null}
        </div>

        <ErrorBox message={error} />
        {success && (
          <p className="text-xs font-semibold text-ok">
            ✓ Admin settings updated successfully.
          </p>
        )}

        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={saving || !specVenueValid || !surgVenueValid}
            variant="primary"
          >
            {saving ? "Saving settings…" : "Save settings"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
