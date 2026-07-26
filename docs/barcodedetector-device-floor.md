# Research: BarcodeDetector on the device floor

**Ticket:** [#44](https://github.com/Piyushmanyata/snp-camps/issues/44) (parent [#41](https://github.com/Piyushmanyata/snp-camps/issues/41))  
**Date:** 2026-07-26  
**Audience:** implementers of [#49](https://github.com/Piyushmanyata/snp-camps/issues/49) (scanner replacement)  
**Scope:** QR decoding only for SNP Desk Slip staff-scan codes on ₹6–10k Android (Chrome) and old Windows desk PCs.

This document answers the seven questions in #44 from primary sources only. Ambiguities are marked with a **safe default**.

---

## One-paragraph recommendation (for #49)

Do **not** treat `BarcodeDetector` as universally available. On **Chrome for Android ≥ 83** it is the preferred decoder **only after** `await BarcodeDetector.getSupportedFormats()` includes `"qr_code"` — the constructor can be present while the Play Services–backed module is missing or broken. On **Chrome for Windows**, native decoding is **not** available; always use the JS fallback. On **iOS Safari**, treat native as unavailable (flag-only). Prefer native when the capability check passes; otherwise **dynamically import `jsQR` (~46 KB gzipped, pure JS, QR-only)** and never ship WASM/CDN fallbacks under the current CSP. Keep the existing generation counter, mount guard, and continuous-autofocus + mild zoom camera constraints; they remain valid for a native `detect()` loop. Multi-scale canvas passes are optional polish, not required for correctness.

---

## 1. Chrome on Android

### Shipping version

| Fact | Source |
|------|--------|
| Barcode detection **launched in Chrome 83** | [Chrome Capabilities — Shape Detection](https://developer.chrome.com/docs/capabilities/shape-detection) (“Barcode detection has launched in Chrome 83”); [ChromeStatus feature 4757990523535360](https://chromestatus.com/feature/4757990523535360) (`android: 83`, `webview: 83`) |
| MDN / BCD: `chrome_android` **version_added: "83"** | [mdn/browser-compat-data `api/BarcodeDetector.json`](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/BarcodeDetector.json) |

Budget Android phones on Chrome 90+ (typical 2022–2026 floor) are past the ship gate.

### QR format

| Fact | Source |
|------|--------|
| Spec enum includes `"qr_code"` | [WICG Shape Detection API § BarcodeFormat](https://wicg.github.io/shape-detection-api/#barcode-detection-api) |
| Limiting formats improves performance | Same spec, `BarcodeDetectorOptions.formats`: “Limiting the search to a particular subset of supported formats is likely to provide better performance.” |
| Example implementation backend on Android is **Google Play Services** barcode APIs | Spec non-normative note: “Example implementations … e.g. [Google Play Services](https://developers.google.com/android/reference/com/google/android/gms/vision/barcode/package-summary)” |

SNP only needs QR. Construct with `{ formats: ["qr_code"] }`.

### Google Play Services dependency — **critical**

| Fact | Source |
|------|--------|
| Official Chrome docs: **“Google Play Services are required on Android.”** | [Operating system support](https://developer.chrome.com/docs/capabilities/shape-detection#operating_system_support) |
| ChromeStatus feature notes: Android **“Requires a device with the Play support libraries installed.”** | [ChromeStatus API payload](https://chromestatus.com/api/v0/features/4757990523535360) (`feature_notes` / `comments`) |
| Spec `getSupportedFormats`: if the UA does not support barcode detection, resolve with an **empty** sequence | [WICG § `getSupportedFormats()`](https://wicg.github.io/shape-detection-api/#dom-barcodedetector-getsupportedformats) steps 2–4 |

**Implication for the device floor:** A ₹6–10k / Android Go handset can run modern Chrome yet have missing, stripped, or stale Play Services. In that case native detection is **not** a rare edge path — it can be common. The constructor may still exist (interface present) while formats are empty or `detect()` fails.

**Safe default:** Never enable native path without a successful formats probe for `"qr_code"`. Treat Play Services failure as “use fallback,” not as an error dialog that blocks the desk.

---

## 2. Correct capability detection

### Why `'BarcodeDetector' in window` is insufficient

Chrome’s own guidance: presence of the constructor **does not** mean the platform can detect. This is intentional. See [Chrome Capabilities — Feature detection](https://developer.chrome.com/docs/capabilities/shape-detection#feature_detection) and the linked design intent ([crbug 920961](https://crbug.com/920961) referenced there).

The WICG algorithm for `getSupportedFormats()` resolves to an **empty array** when the UA does not support barcode detection — it does not throw solely for “module missing.”

### Copy-able sequence (use this in #49)

```ts
/**
 * Returns true only when this browsing context can actually decode QR codes
 * with the platform BarcodeDetector (not merely expose the interface).
 */
export async function canUseNativeQrDetector(): Promise<boolean> {
  try {
    if (typeof globalThis.BarcodeDetector !== "function") return false;
    // Spec: await static getSupportedFormats(); empty list ⇒ no backing module.
    const formats = await globalThis.BarcodeDetector.getSupportedFormats();
    if (!Array.isArray(formats) || !formats.includes("qr_code")) return false;
    // Optional hard probe: some platforms list formats but reject detect().
    // Safe default on device floor: skip probe if formats already list qr_code,
    // because constructing + detect on a blank canvas can be expensive/noisy.
    return true;
  } catch {
    return false;
  }
}

// Usage before opening camera:
// if (await canUseNativeQrDetector()) { /* native loop */ }
// else { const { default: jsQR } = await import("jsqr"); /* fallback */ }
```

| Check | Result when unsupported |
|-------|-------------------------|
| `'BarcodeDetector' in window` | May still be **true** on Windows Chrome (interface visible historically) or when Play Services is broken |
| `await getSupportedFormats()` | **Empty array** per WICG when UA cannot detect; or list **without** `"qr_code"` |
| `formats.includes("qr_code")` | Required gate for SNP |

**Do not** use the FaceDetector-style “detect on empty canvas and catch `NotSupportedError`” pattern as the primary gate for barcodes: Chrome documents `getSupportedFormats()` specifically for this API.

**Ambiguity:** Whether a non-empty formats list can still yield permanent `detect()` failures without empty formats is under-documented. **Safe default:** after 5 consecutive `detect()` rejections (existing `qr-scanner.tsx` behaviour), abandon native for that session and offer manual reg entry; do not hot-swap mid-stream unless #49 explicitly wants it.

---

## 3. Chrome on Windows desktop (volunteer desk PC)

| Fact | Source |
|------|--------|
| BCD: desktop Chrome support is **partial** — notes: **“Supported on ChromeOS and macOS only.”** (not Windows) | [mdn/browser-compat-data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/BarcodeDetector.json) (`chrome` entries from 83/88) |
| ChromeStatus OS notes list Android (Play libraries), macOS, Chrome OS — **not Windows** | [ChromeStatus feature notes](https://chromestatus.com/api/v0/features/4757990523535360); [Chrome OS support](https://developer.chrome.com/docs/capabilities/shape-detection#operating_system_support) |
| MDN BCD issue history: interface made visible widely but **not implemented on Windows/Linux** historically | [mdn/browser-compat-data#7184](https://github.com/mdn/browser-compat-data/issues/7184) (primary tracker for platform notes) |

**Honest support:** On a typical Windows volunteer desk PC, **assume native BarcodeDetector will fail the formats check** and the fallback is the **common** path, not the rare one.

**Safe default:** Same capability sequence as Android; never special-case `navigator.platform`.

---

## 4. iOS Safari / WebKit

| Fact | Source |
|------|--------|
| Safari / iOS Safari: `version_added: "17"` **only behind flag** `"Shape Detection API" = true` | [mdn/browser-compat-data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/BarcodeDetector.json) |
| No shipping, flag-free WebKit equivalent for production web content | Same BCD: no unflagged `version_added` |

**Confirm:** treat iOS Safari as **absent** for production. Do not depend on a WebKit-native QR API. SNP camps are not iOS-primary, but if a staff member uses an iPhone, **jsQR (or manual entry)** is the path.

---

## 5. Fallback decoder comparison

Sizes measured via Bundlephobia package API (minified gzip of the **published JS entry**; date of this research: 2026-07-26). WASM sizes from the libraries’ own READMEs.

| Candidate | What it is | JS min+gzip (Bundlephobia) | Additional runtime payload | Dynamic import? | Maintenance (primary) | Fit for SNP |
|-----------|------------|----------------------------:|----------------------------|-----------------|----------------------|-------------|
| **`jsQR`** ([npm](https://www.npmjs.com/package/jsqr), [GitHub cozmo/jsQR](https://github.com/cozmo/jsQR)) | Pure JS QR locator+decoder | **~46.4 KB** (v1.4.0; raw ~130 KB) | None | Yes (`import("jsqr")`) | Stable; last npm 1.4.0 is older (QR-only, low surface) | **Recommended** |
| **`zxing-wasm`** ([GitHub Sec-ant/zxing-wasm](https://github.com/Sec-ant/zxing-wasm)) | ZXing-C++ → WASM | ~13.5 KB JS shell (v3.1.2) | **~1.04 MiB** reader WASM / **~1.46 MiB** full ([README](https://github.com/Sec-ant/zxing-wasm)) | Yes, but WASM fetch required | Active | Overkill; huge on 2–4 GB devices |
| **`barcode-detector`** ([GitHub Sec-ant/barcode-detector](https://github.com/Sec-ant/barcode-detector)) | BarcodeDetector ponyfill over zxing-wasm | ~14.4 KB JS (v3.2.1) | Same WASM as zxing-wasm; default CDN locateFile | Yes | Active | API-shaped, but WASM + CDN vs CSP |

### Current dependency for context

`html5-qrcode` is already in the app (`package.json`). It is a full scanner UI/engine, not a ≤20 KB QR decode primitive; #49 is instructed to replace it, not keep it as the long-term fallback.

### Target ≤ 20 KB gzipped

**None of the three candidates meet ≤20 KB gzipped as a complete, self-contained decoder:**

- `jsQR` is ~**46 KB** gzip (over target by ~26 KB) but zero extra network and pure QR.
- `zxing-wasm` / `barcode-detector` JS shells look small (~13–14 KB) but the **real cost is ~1 MiB WASM**, far above target, and the default CDN path conflicts with production CSP (`connect-src 'self' + Supabase only` in `src/lib/csp.ts`).

### Recommendation: **`jsQR` at ~46 KB gzipped**

Reasons:

1. **QR-only** matches product need (no 1D barcode formats).
2. **Complete in one download** — no WASM, no second-hop CDN, works offline after first load.
3. **Dynamic import** so devices that pass the native check download **nothing**.
4. **CSP-safe** under current `script-src` / `connect-src` (bundle from `'self'`).
5. Acceptable CPU cost on a desk: call at ~5–10 FPS on a downscaled `ImageData` (not full 720p every frame if the phone is struggling).

**Ambiguity / trade-off flagged:** exceeds the aspirational 20 KB budget. **Safe default for #49:** ship `jsQR` anyway; do **not** take WASM to “win” the JS-shell size number. If a future ticket reopens size, measure a custom ZXing reader build served from `public/` under CSP — out of scope for #44.

---

## 6. Camera constraints for the device floor

Primary APIs: [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) (`getUserMedia`), optional [MediaStream Image Capture](https://w3c.github.io/mediacapture-image/) (`getCapabilities` / `applyConstraints` for focus, zoom, torch).

### Recommended constraints (aligned with current `qr-scanner.tsx`)

| Constraint | Recommendation | Still needed with native? |
|------------|----------------|---------------------------|
| `facingMode: { ideal: "environment" }` | Prefer rear camera | **Yes** — optics, not decoder |
| `width` / `height` ideal **1280×720** | Good default; UA may deliver less on cheap sensors | **Yes** — more pixels help small paper QR; native does not invent resolution |
| `focusMode: "continuous"` when advertised | Best-effort via `getCapabilities` | **Yes** — paper slips at arm’s length |
| Mild **zoom** (~35% of advertised range) when available | Improves module size on distant slips | **Yes** — same reason |
| **Torch** | Best-effort only if `torch` in capabilities; many budget sensors lack it | Optional; never require |
| FPS of decode loop | ~**10 FPS** (existing `SCANNER_FPS`) | **Yes** — native `detect()` is async; do not run unbounded rAF work |

### What was compensating for a weak JS decoder vs still needed for native

| Technique in `src/components/qr-scanner.tsx` | Role |
|----------------------------------------------|------|
| Multi-scale / center-crop canvas passes | Partly compensates for soft focus and small modules; **still useful** with native on blurry frames, but **not required for correctness**. #49 may keep every-other-tick crop as polish. |
| Continuous autofocus + mild zoom | **Camera-side** — keep for both paths |
| 1280×720 ideal | **Camera-side** — keep |
| Falling back after consecutive detect errors | **Reliability** — keep for native Play Services flakiness |

**Safe default:** keep autofocus/zoom/`facingMode`/resolution; keep FPS throttle; multi-scale canvas is optional.

---

## 7. Teardown races — keep generation + mount guards

Existing patterns in `src/components/qr-scanner.tsx`:

- `scannerGeneration` incremented on every `stopScanner` / `start`
- `isMounted` flipped false on unmount
- Async `getUserMedia`, `detect()`, and `html5-qrcode` start all re-check generation before applying state
- `requestAnimationFrame` loop aborts when generation mismatches
- `handledRef` prevents double-resolve on the same code

### Do these still apply to a pure `BarcodeDetector` loop?

**Yes.** Reasons from the async model:

1. **`detect()` returns a Promise** ([WICG](https://wicg.github.io/shape-detection-api/#dom-barcodedetector-detect)). Completions can land after `stop()` or unmount.
2. **`getUserMedia` is async** — user can navigate away mid-permission.
3. **rAF + await** interleaving can schedule another frame after stop unless generation is checked **before and after** `await detector.detect(...)`.
4. Spec warns detectors may hold significant resources; reuse one instance per session, but **must** stop tracks and drop references on teardown.

**Instruction for #49:** preserve generation counter + mount guard + “don’t call setState after unmount.” Do not replace with a simpler `let cancelled` unless it covers the same start/stop re-entrancy (generation is stronger when start can be invoked twice quickly).

---

## Implementer checklist (#49)

1. Replace `getBarcodeDetectorClass()` with `canUseNativeQrDetector()` (formats include `qr_code`).
2. Native path: `new BarcodeDetector({ formats: ["qr_code"] })`, reuse instance, video element as `detect()` source.
3. Fallback path: `const { default: jsQR } = await import("jsqr")` only when native check fails; decode from `ImageData` at throttled FPS.
4. Manual reg-number entry remains first-class (already present).
5. Do not load `html5-qrcode` once jsQR + native cover both paths (budget win).
6. Update route budgets after removing `html5-qrcode`.
7. Preserve generation / mount / handled guards.

---

## Sources (primary)

1. [WICG Accelerated Shape Detection in Images](https://wicg.github.io/shape-detection-api/) — API, `getSupportedFormats`, `qr_code`, Play Services example note  
2. [Chrome Capabilities: Shape Detection](https://developer.chrome.com/docs/capabilities/shape-detection) — Chrome 83 launch, feature detection, **Play Services required on Android**, OS matrix  
3. [ChromeStatus: Barcode Detection API](https://chromestatus.com/feature/4757990523535360) / [JSON API](https://chromestatus.com/api/v0/features/4757990523535360) — milestones Android/WebView 83, Play support libraries note  
4. [MDN BarcodeDetector](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector) and [browser-compat-data `BarcodeDetector.json`](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/BarcodeDetector.json) — platform version matrix, Safari flag, no Windows desktop support  
5. [jsQR](https://github.com/cozmo/jsQR) / [npm jsqr](https://www.npmjs.com/package/jsqr) + [Bundlephobia size API](https://bundlephobia.com/api/size?package=jsqr)  
6. [zxing-wasm README](https://github.com/Sec-ant/zxing-wasm) — WASM sizes (~1.04–1.46 MiB)  
7. [barcode-detector README](https://github.com/Sec-ant/barcode-detector) — ponyfill over zxing-wasm  
8. Repo: `src/components/qr-scanner.tsx`, `src/lib/csp.ts`

---

## Ambiguities summary

| Topic | Evidence quality | Safe default |
|-------|------------------|--------------|
| Play Services missing vs empty formats | Chrome docs require GPS; exact fail mode varies | Formats check + catch on `detect()` |
| Windows Chrome ever gaining support | BCD says ChromeOS/macOS only as of BCD data used | Always run formats check; expect fallback |
| ≤20 KB fallback target | No complete pure decoder ≤20 KB among listed candidates | **jsQR ~46 KB gzip** |
| Multi-scale canvas necessity with native | Not specified by platform docs | Optional; keep if field testing needs it |
