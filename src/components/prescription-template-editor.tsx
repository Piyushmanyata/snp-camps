"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  DEFAULT_PRESCRIPTION_TEMPLATE,
  resolvePrescriptionTemplate,
  type PrescriptionTemplate,
} from "@/lib/prescription-template";
import { Button, Card, ErrorBox, Input, SectionTitle } from "@/components/ui";

type SponsorAsset = {
  id: string;
  url: string;
  state: "pending" | "ready" | "deleting";
  cleanup_attempts: number;
};

export function PrescriptionTemplateEditor({ campId }: { campId: string }) {
  const [template, setTemplate] = useState<PrescriptionTemplate>(
    DEFAULT_PRESCRIPTION_TEMPLATE,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [assets, setAssets] = useState<SponsorAsset[]>([]);
  const sectionHeight = template.sections
    .filter((section) => section.visible !== false)
    .reduce((sum, row) => sum + row.heightMm, 0);
  const fitsOnePage = sectionHeight <= 42 && template.sponsorLogos.length <= 8;

  useEffect(() => {
    let active = true;
    const supabase = createClient();
    void supabase
      .rpc("admin_prescription_template_editor", { p_camp_id: campId })
      .then(({ data, error: rpcError }) => {
        if (!active) return;
        if (rpcError) setError("Saved template could not be loaded.");
        else if (data) setTemplate(resolvePrescriptionTemplate(data));
      });
    return () => { active = false; };
  }, [campId]);

  useEffect(() => {
    let active = true;
    void fetch(`/api/admin/sponsor-assets?campId=${encodeURIComponent(campId)}`, {
      cache: "no-store",
    })
      .then((response) => response.json())
      .then((body) => {
        if (active && Array.isArray(body.assets)) setAssets(body.assets as SponsorAsset[]);
      })
      .catch(() => {
        if (active) setError("Sponsor assets could not be loaded.");
      });
    return () => { active = false; };
  }, [campId]);

  function move<T>(items: T[], index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }

  type EditableList = "diagnosisOptions" | "vitalsFields";
  const listLimits: Record<EditableList, number> = {
    diagnosisOptions: 6,
    vitalsFields: 4,
  };

  function updateList(key: EditableList, index: number, value: string) {
    setTemplate((current) => ({
      ...current,
      [key]: current[key].map((item, itemIndex) =>
        itemIndex === index ? value.slice(0, 80) : item,
      ),
    }));
  }

  function addListItem(key: EditableList) {
    setTemplate((current) => ({
      ...current,
      [key]: current[key].length < listLimits[key] ? [...current[key], ""] : current[key],
    }));
  }

  function removeListItem(key: EditableList, index: number) {
    setTemplate((current) => ({
      ...current,
      [key]: current[key].filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  async function upload(file: File | null) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("campId", campId);
      form.set("file", file);
      const response = await fetch("/api/admin/sponsor-assets", {
        method: "POST",
        body: form,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setError(body.error ?? "Upload failed.");
      else {
        setTemplate((current) => ({
          ...current,
          sponsorLogos: [...current.sponsorLogos, body.url].slice(0, 8),
        }));
        const assetsResponse = await fetch(
          `/api/admin/sponsor-assets?campId=${encodeURIComponent(campId)}`,
          { cache: "no-store" },
        );
        const assetsBody = await assetsResponse.json().catch(() => ({}));
        if (Array.isArray(assetsBody.assets)) setAssets(assetsBody.assets as SponsorAsset[]);
      }
    } catch {
      setError("Upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function reconcileAsset(asset: SponsorAsset) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/sponsor-assets/${asset.id}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "Asset cleanup failed.");
        return;
      }
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      setTemplate((current) => ({
        ...current,
        sponsorLogos: current.sponsorLogos.filter((logo) => logo !== asset.url),
      }));
    } catch {
      setError("Asset cleanup failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function removeLogo(index: number) {
    setTemplate((current) => ({
      ...current,
      sponsorLogos: current.sponsorLogos.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  async function save(publish: boolean, value = template) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const supabase = createClient();
    try {
      const { error: rpcError } = await supabase.rpc(
        "admin_save_prescription_template",
        {
          p_camp_id: campId,
          p_template: {
            ...value,
            fitsOnePage:
              value.sections.filter((section) => section.visible !== false)
                .reduce((sum, section) => sum + section.heightMm, 0) <= 42 &&
              value.sponsorLogos.length <= 8,
          },
          p_publish: publish,
        },
      );
      if (rpcError) {
        setError(
          /template sections/i.test(rpcError.message)
            ? "Each block needs a label and the visible blocks must total 42 mm or less."
             : /sponsor asset/i.test(rpcError.message)
              ? "One of the sponsor logos is not an uploaded asset. Remove it and upload again."
              : /admin only/i.test(rpcError.message)
                ? "Only an admin can save the template."
                : "Template could not be saved.",
        );
      } else setMessage(publish ? "Template published." : "Draft saved.");
    } catch {
      setError("Template could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4">
      <div>
        <SectionTitle>Prescription template</SectionTitle>
        <p className="text-sm text-muted">
          Protected patient identity, registration number, and Patient QR stay fixed.
        </p>
      </div>
      <label className="block text-sm font-semibold">
        Add sponsor logo
        <input
          className="mt-2 block min-h-12 w-full rounded-xl border border-border bg-white p-2"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy || template.sponsorLogos.length >= 8}
          onChange={(event) => void upload(event.target.files?.[0] ?? null)}
        />
      </label>
      <ul className="space-y-2">
        {template.sponsorLogos.map((url, index) => (
          <li key={`${url}-${index}`} className="flex items-center gap-2 rounded-xl border border-border p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={`Sponsor ${index + 1}`} className="h-12 w-20 object-contain" />
            <span className="flex-1 text-xs text-muted">Sponsor {index + 1}</span>
            <Button type="button" size="sm" variant="secondary" disabled={index === 0} onClick={() => setTemplate((current) => ({ ...current, sponsorLogos: move(current.sponsorLogos, index, -1) }))}>Up</Button>
            <Button type="button" size="sm" variant="secondary" disabled={index === template.sponsorLogos.length - 1} onClick={() => setTemplate((current) => ({ ...current, sponsorLogos: move(current.sponsorLogos, index, 1) }))}>Down</Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => removeLogo(index)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {assets.length ? (
        <section aria-labelledby="sponsor-assets-heading" className="space-y-2">
          <h3 id="sponsor-assets-heading" className="text-sm font-semibold">Sponsor asset cleanup</h3>
          {assets.map((asset) => (
            <div key={asset.id} className="flex items-center gap-2 rounded-xl border border-border p-2">
              <span className="flex-1 text-sm">
                {asset.state === "ready" ? "Ready" : asset.state === "pending" ? "Pending upload" : "Deletion pending"}
                {asset.cleanup_attempts ? ` · ${asset.cleanup_attempts} attempt(s)` : ""}
              </span>
              {asset.state !== "ready" ? (
                <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void reconcileAsset(asset)}>
                  {asset.state === "pending" ? "Clean up upload" : "Retry deletion"}
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {(["diagnosisOptions", "vitalsFields"] as const).map((key) => (
        <fieldset key={key} className="space-y-2 rounded-xl border border-border p-3">
          <legend className="text-sm font-semibold">
            {key === "diagnosisOptions" ? "Diagnosis tick-boxes" : "Vitals fields"}
          </legend>
          {template[key].map((value, index) => (
            <div key={`${key}-${index}`} className="flex items-end gap-2">
              <Input
                id={`template-${key}-${index}`}
                label={`${key === "diagnosisOptions" ? "Diagnosis" : "Vital"} ${index + 1}`}
                value={value}
                onChange={(event) => updateList(key, index, event.target.value)}
              />
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => removeListItem(key, index)}>
                Remove
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="secondary" disabled={busy || template[key].length >= listLimits[key]} onClick={() => addListItem(key)}>
            Add {key === "diagnosisOptions" ? "diagnosis" : "vital"}
          </Button>
        </fieldset>
      ))}
      <div className="space-y-3">
        {template.sections.map((section, index) => (
          <div key={section.key} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1fr_9rem_auto]">
            <Input
              id={`template-label-${section.key}`}
              label="Approved block label"
              value={section.label}
              onChange={(event) => setTemplate((current) => ({
                ...current,
                sections: current.sections.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, label: event.target.value.slice(0, 80) } : item,
                ),
              }))}
            />
            <label className="text-sm font-semibold">
              Writing height
              <select
                className="mt-1 min-h-12 w-full rounded-xl border border-border bg-white px-3"
                value={section.heightMm}
                onChange={(event) => setTemplate((current) => ({
                  ...current,
                  sections: current.sections.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, heightMm: Number(event.target.value) } : item,
                  ),
                }))}
              >
                {[10, 16, 20, 26, 32].map((height) => <option key={height} value={height}>{height} mm</option>)}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <Button type="button" size="sm" variant="secondary" disabled={index === 0} onClick={() => setTemplate((current) => ({ ...current, sections: move(current.sections, index, -1) }))}>Up</Button>
              <Button type="button" size="sm" variant="secondary" disabled={index === template.sections.length - 1} onClick={() => setTemplate((current) => ({ ...current, sections: move(current.sections, index, 1) }))}>Down</Button>
            </div>
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={section.visible !== false}
                onChange={(event) => setTemplate((current) => ({
                  ...current,
                  sections: current.sections.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, visible: event.target.checked } : item,
                  ),
                }))}
              />
              Visible
            </label>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border bg-white p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-muted">Live A4 preview</p>
        <div className="mx-auto mt-3 aspect-[210/297] max-w-sm border border-slate-300 p-4 shadow-sm">
          <div className="rounded border-2 border-slate-800 p-2 text-center text-xs font-bold">Protected patient identity · Reg. No. · Patient QR</div>
          {template.sections.filter((section) => section.visible !== false).map((section) => (
            <div key={section.key} className="mt-2 border border-slate-400 p-1 text-xs" style={{ height: `${Math.max(30, section.heightMm * 2)}px` }}>{section.label}</div>
          ))}
          <p className="mt-2 text-center text-[10px]">{template.sponsorLogos.length} sponsor logo(s)</p>
        </div>
        <p className={`mt-2 text-sm font-semibold ${fitsOnePage ? "text-success" : "text-danger"}`}>
          {fitsOnePage ? "Fits one A4 page" : "Too tall to publish"}
        </p>
      </div>
      <ErrorBox message={error} />
      {message ? <p role="status" className="text-sm font-semibold text-success">{message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void save(false)}>Save draft</Button>
        <Button type="button" disabled={busy || !fitsOnePage} onClick={() => void save(true)}>Publish</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => {
          if (!window.confirm("Replace this camp's published template with the default? The current template becomes superseded.")) return;
          setTemplate(DEFAULT_PRESCRIPTION_TEMPLATE);
          void save(true, DEFAULT_PRESCRIPTION_TEMPLATE);
        }}>Restore default</Button>
      </div>
    </Card>
  );
}
