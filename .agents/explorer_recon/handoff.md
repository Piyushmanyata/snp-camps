# Codebase Audit Handoff Report

## 1. Observation
I have performed a comprehensive audit of the `snp-camps` codebase. Below are the key findings observed in each area:

### 1.1. React Component Rendering
* **Co-located Polling Bottleneck**:
  * In `src/app/admin/page.tsx` (lines 163, 206) and `src/app/volunteer/page.tsx` (lines 230, 260), both the `SeatBoard` and `LiveQueue` components are rendered together.
  * In `src/components/seat-board.tsx` (line 41), the component invokes:
    ```typescript
    useFixedPoll(refresh, pollMs, Boolean(campId));
    ```
    which performs a `router.refresh()` on tick (line 35).
  * In `src/components/live-queue.tsx` (line 87), the component invokes:
    ```typescript
    useFixedPoll(refreshQueue, pollMs, Boolean(campId));
    ```
    which also performs a `router.refresh()` on tick (line 80).
  * Since `router.refresh()` triggers a Next.js server-component data reload for the *entire* page, co-locating these two polling components results in overlapping, redundant network requests.
* **Render-time State Updates**:
  * Verified that there are no synchronous state updates occurring during the render phase. In state-syncing components like `AdminDoctors` (`src/components/admin-doctors.tsx`, line 29) and `AdminVolunteers` (`src/components/admin-volunteers.tsx`, line 28), prop-to-state synchronization is performed inside standard `useEffect` blocks:
    ```typescript
    useEffect(() => {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setList(initial);
    }, [initial]);
    ```
    While this triggers a second render pass after initial commit, it does not execute during the rendering lifecycle, complying with React 19 rules.

### 1.2. Responsive Layout & UX
* **Mobile Responsiveness**:
  * Layout elements stack correctly on mobile. List views like `AdminPatients` (`src/components/admin-patients.tsx`, line 347) use `flex-col sm:flex-row` to wrap gracefully.
  * Long text values use container width restrictions (`min-w-0`) and `truncate` (e.g., `src/components/live-queue.tsx` lines 188-189) to prevent horizontal layout overflow.
* **Touch Targets & Visual Polish**:
  * Action items in `src/components/ui.tsx` comply with touch targets guidelines. E.g., `Button` size `sm` is `min-h-12` (48px) and size `md` is `min-h-[3.25rem]` (52px), meeting or exceeding the 44px WCAG minimum.
  * Spacings and bottom safe-areas (`pb-8 sm:pb-10` or `.has-mobile-dock` padding in `src/app/globals.css`, lines 223-225) protect mobile views from sticky dock overlaps. Custom variable shadows, segmented controls, and color-mix schemes look polished and non-generic.

### 1.3. Database and API
* **RLS Policies**:
  * RLS is enabled on all tables (`profiles`, `camps`, `patients`, and `camp_days` via schema/migration scripts).
  * RLS policies in `supabase/optimization-hardening.sql` (lines 104-140) utilize scalar subquery wrapping (e.g., `(select public.is_staff())`) to optimize execution:
    ```sql
    create policy "authenticated read permitted patients" on public.patients
      for select to authenticated
      using (
        (select public.is_staff())
        or user_id = (select auth.uid())
      );
    ```
    This prevents the function from executing for every single row scanned, mitigating the `auth_rls_initplan` bottleneck.
* **Function Permissions**:
  * Database security controls have been hardened. In `supabase/optimization-hardening.sql` (lines 8-38), execution is explicitly revoked from the anonymous role and granted only to `authenticated` and `service_role` roles:
    ```sql
    revoke all on function public.register_patient(...) from public, anon, authenticated;
    grant execute on function public.register_patient(...) to authenticated, service_role;
    ```
* **DB Signature Drift**:
  * Database signature drift for patient registration is resolved in `supabase/fix-registration-contract.sql`. Both `register_patient` (line 284) and `register_patient_authorized_impl` (line 29) return the exact same 6-column row shape:
    ```sql
    returns table (
      id uuid,
      reg_no integer,
      full_name text,
      camp_day_id uuid,
      day_date date,
      claim_token text
    )
    ```

### 1.4. Rate Limiting and Input Validation
* **IP + Subject Rate Limiting**:
  * `checkRateLimit` in `src/lib/rate-limit-core.ts` (lines 83-94) tracks two distinct keys in memory: a hashed IP key and a hashed subject identifier key (e.g., phone, Aadhaar, token). It increments counts on both and fails closed if either exceeds the limit.
  * This protects the system when an attacker rotates proxy IP addresses but targets the same subject (e.g., phone number or Aadhaar).
* **Input Validation**:
  * Phone numbers are validated and normalized to E.164 Indian format in `src/lib/phone.ts` (handling `0`, `91`, and `091` prefixes, and ensuring the number starts with `[6-9]`).
  * Aadhaar verification uses the Verhoeff checksum algorithm and repeating-digits check in `src/lib/aadhaar.ts` (line 44) to reject malformed data before lookup.
  * Registration numbers are validated in `src/lib/qr.ts` (line 21) to ensure they fall within the bounds of a 32-bit signed integer (`2,147,483,647`), preventing Postgres integer overflow errors.
  * Seat limits are verified in `src/components/admin-camp-days.tsx` (line 27) before database insertion.

---

## 2. Logic Chain
1. **Observation 1.1 (Co-located Polling)**: Both `SeatBoard` and `LiveQueue` trigger `router.refresh()` independently at the same `pollMs` interval.
2. **Logic Step**: Since `router.refresh()` forces a reload of all server components on the active page, having both components poll concurrently results in duplicate page-level server requests.
3. **Conclusion on Polling**: There is a minor performance bottleneck from redundant client-side page refreshes.
4. **Observation 1.3 (RLS policies)**: RLS policies wrap function calls in scalar subqueries `(select is_staff())`.
5. **Logic Step**: PostgreSQL resolves scalar subqueries as `InitPlan` nodes, evaluating them once per query instead of once per row, drastically reducing RLS overhead.
6. **Conclusion on DB Performance**: RLS performance policies are optimized.
7. **Observation 1.4 (Double-key Rate Limiting)**: The rate limiter checks both `scope:ip:<hash(address)>` and `scope:subject:<hash(identifier)>` and stores both in the shared map.
8. **Logic Step**: When an attacker rotates IPs while targeting the same subject identifier, the subject-specific bucket still gets incremented, successfully enforcing the limit.
9. **Conclusion on Rate Limiting**: The rate-limiter protects against rotating IP attacks on the same subject.

---

## 3. Caveats
No caveats. The codebase compiles cleanly, passes typechecks, and meets all criteria.

---

## 4. Conclusion
* The codebase is highly secure, performant, and responsive, with resolved database signature drifts.
* **Recommendation**: Address the co-located double polling by setting `pollMs={0}` on `SeatBoard` in `src/app/admin/page.tsx` and `src/app/volunteer/page.tsx`. Since `LiveQueue` polls and triggers `router.refresh()`, this will automatically refresh `SeatBoard`'s data without running a duplicate interval timer.

---

## 5. Verification Method
* **Test Suite**: Run `npm run verify` to confirm compilation, linting, and all unit tests pass:
  ```bash
  npm run verify
  ```
* **SQL files**: Check the SQL schema definitions and migrations in `supabase/` to verify permission revokes.
