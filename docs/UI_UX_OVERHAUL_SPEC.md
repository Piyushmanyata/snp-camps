# Specification: SNP Camps UI/UX Deep Overhaul

> **Superseded by [spec #41](https://github.com/Piyushmanyata/snp-camps/issues/41) and accepted design-system rules in `CONTEXT.md` (#69, #73)**.  
> Retained solely as a historical record of the original Emerald & Slate draft. Do not reconcile the product against this document — glow/glass typography, glassmorphic headers, and status badge glows are retired and superseded by high-contrast WCAG AA rules in `CONTEXT.md`. Per Document Authority Precedence, remediation contracts (#56, #68, #72, #74), `CONTEXT.md`, and `README.md` supersede historical spec files.

## Problem Statement

The SNP Camps medical desk application serves patients, volunteers, doctors, and administrators during high-volume, fast-paced eye treatment camps organized by Sikar Nagarik Parishad (Kolkata).

Currently, the interface uses generic UI styling with limited visual hierarchy, standard browser typography, basic color tokens, and plain feedback states. Under outdoor sunlight glare, high-density queue lists can be difficult to read quickly, status changes lack distinct visual cues, tactile press feedback on mobile touchscreens is minimal, and the interface feels functional rather than state-of-the-art.

Field staff (volunteers and doctors) need to register patients, scan QR codes, assign doctors, and clear queues with zero operational friction, while patients need a crystal-clear, high-contrast experience during self-registration and status tracking.

## Solution

A comprehensive, end-to-end UI/UX overhaul implementing an **Emerald & Slate Medical Tech Design System** built with **Plus Jakarta Sans**, tactile micro-interactions, glassmorphic navigation chrome, glowing status badges, and accessible high-contrast field components.

The overhaul elevates the visual aesthetic across all four primary role views (Patient Portal, Volunteer Desk, Doctor Station, Admin Dashboard) while adhering to **Ponytail** principles (minimal code diffs, zero unnecessary abstractions, utility-first design) and **LeanCTX** performance standards.

## User Stories

1. As a Patient, I want a clean, mobile-optimized self-registration form with clear label hierarchy and large input touch targets, so that I can easily enter my details without input errors under field conditions.
2. As a Patient, I want to see my phone OTP verification and backup password presented with high-contrast card elevation, so that I can easily note down or verify my login details.
3. As a Patient, I want my unique Patient QR code rendered crisply with explicit scan guidance, so that volunteers or doctors can instantly scan my slip.
4. As a Patient, I want a live queue status view with glowing state indicators (Waiting, Doctor Scanning, Seen), so that I know my current position in line.
5. As a Volunteer, I want a high-velocity desk dashboard with a glassmorphic header and clear role badge, so that I can quickly switch between patient registration, queue searching, and desk printing.
6. As a Volunteer, I want the QR scanner viewport to feature smooth camera framing and clear scan overlay bounds, so that patient QR codes are recognized instantaneously.
7. As a Volunteer, I want to see candidate doctor assign buttons formatted as high-contrast tactile action chips, so that I can assign patients in a single tap.
8. As a Doctor, I want a streamlined scanning interface with immediate tactile feedback, so that I can scan and clear patient records without delay.
9. As a Doctor, I want clear warning banners when a patient has already been seen by another doctor, so that duplicate examinations are prevented without confusion.
10. As a Doctor, I want real-time stats (Total Patients, Seen Count, Waiting Count) rendered with tabular numbers and distinct color tones, so that I can track camp progress at a glance.
11. As an Admin, I want a comprehensive multi-desk monitoring view with collapsible section panels, so that I can manage camps, camp days, volunteers, and doctors without visual clutter.
12. As an Admin, I want action cards and status metrics to feature subtle hover lifts and tactile press animations, so that the dashboard feels responsive and premium.
13. As any User, I want glassmorphic toast notifications to confirm actions (e.g., "Patient Registered", "Doctor Assigned", "Desk Slip Printed"), so that I receive immediate feedback.
14. As any User on a mobile device, I want a sticky mobile action dock with touch-friendly dimensions and backdrop blur, so that primary desk actions remain accessible at all times.
15. As a keyboard or screen-reader user, I want visible focus rings (`ring-emerald-500/40`), logical heading structures, skip links, and full WCAG 2.2 accessibility, so that the application is usable by everyone.

## Implementation Decisions

### Design Tokens & Visual Hierarchy
- **Primary Color**: Emerald `#059669` (mid) / `#047857` (dark) / `#d1fae5` (soft wash).
- **Background & Cards**: Light Slate `#f8fafc` background with `#ffffff` elevated cards, subtle borders (`#e2e8f0`), and soft shadows.
- **Dark Elements & Navigation**: Glassmorphic slate header with backdrop blur (`backdrop-blur-md`).
- **Status Indicators**: Distinct glow badges for `waiting` (amber soft glow), `scanning` (emerald soft glow), and `seen` (slate/green soft glow).

### Typography System
- Integrate `Plus_Jakarta_Sans` via `next/font/google` in the root layout.
- Use tabular numeric alignment (`font-variant-numeric: tabular-nums`) for registration IDs, queue counts, time displays, and statistics.

### Component Overhauls
- **Shell & Navigation**: Refine header layout, role badge styling, back button press states, and sticky mobile dock.
- **Card & Collapsible Panel**: Modernize border radii, shadow depths, details/summary animation handles, and section title typography.
- **Buttons & Touch Controls**: Implement tactile press scaling (`scale(0.98)`), smooth focus rings, loading spinners, and multi-variant styles (primary emerald, secondary soft, danger, ghost).
- **Form Controls**: High-contrast border transitions, floating hint text, red error banners, and touch-target padding (min 48px height).
- **Banners & Toasts**: Floating glassmorphic toast notification component with enter/exit CSS keyframe animations.

## Testing Decisions

### Seams
- **Primary Testing Seam**: Full-stack Next.js production gate via `npm run verify` (lint, `tsc --noEmit`, unit, DB, build, JS budget and e2e, in that order).
- **End-to-End Testing Seam**: Playwright browser test suite via `npm run test:e2e` exercising patient self-registration, volunteer desk operations, doctor QR scan workflow, and admin management screens.

### Test Criteria
- Tests must verify external application behavior and DOM accessibility standards rather than internal state implementation details.
- Build must compile cleanly with zero TypeScript errors, zero ESLint warnings, and zero broken CSS variables.
- Visual elements must respect `prefers-reduced-motion` media queries.

## Out of Scope

- Changes to Supabase backend schema or SQL migrations (existing schema v3 contracts are preserved).
- Changes to API contracts (`/api/health`, Auth OTP endpoints, printer webhooks).
- Third-party Aadhaar lookup API integrations.

## Further Notes

- All changes maintain strict backward compatibility with existing Supabase Auth and RLS policies.
- Minimal CSS footprint maintained by leveraging Tailwind CSS v4 directives and CSS custom properties in `globals.css`.
