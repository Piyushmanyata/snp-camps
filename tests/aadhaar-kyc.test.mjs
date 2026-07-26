import assert from "node:assert/strict";
import test from "node:test";
import {
  createDecentroAadhaarKycProvider,
  createDigioAadhaarKycProvider,
  createMockAadhaarKycProvider,
  getAadhaarKycProvider,
} from "../src/lib/aadhaar-kyc.ts";

const validAadhaar = "999999990019";

test("unconfigured or unknown provider selection is explicit and disabled", () => {
  assert.equal(getAadhaarKycProvider({ env: {} }), null);
  assert.equal(
    getAadhaarKycProvider({ env: { AADHAAR_KYC_PROVIDER: "unknown" } }),
    null,
  );
});

test("mock provider completes deterministically and maps OTP failures", async () => {
  const provider = createMockAadhaarKycProvider();
  const initiated = await provider.initiateKyc(validAadhaar);
  assert.deepEqual(initiated, {
    ok: true,
    txnId: "mock-kyc-txn",
    maskedMobile: "******3210",
  });

  const rejected = await provider.verifyOtp(initiated.txnId, "000000");
  assert.deepEqual(rejected, {
    ok: false,
    detail: "Mock OTP rejected",
    failureKind: "rejected",
  });

  const verified = await provider.verifyOtp(initiated.txnId, "123456");
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.profile.full_name, "Aadhaar Test Patient");
    assert.equal(verified.profile.gender, "F");
    assert.equal(verified.phone, "919876543210");
    assert.equal(JSON.stringify(verified).includes(validAadhaar), false);
  }
});

test("Digio validates Verhoeff before HTTP and enforces redirect and timeout bounds", async () => {
  let calls = 0;
  let request;
  const provider = createDigioAadhaarKycProvider({
    initiateUrl: "https://digio.example/initiate",
    verifyUrl: "https://digio.example/verify",
    apiKey: "digio-test-key",
    fetchImpl: async (_input, init) => {
      calls += 1;
      request = init;
      return new Response(JSON.stringify({ txn_id: "digio-txn", masked_mobile: "******0019" }), {
        status: 200,
      });
    },
    timeoutMs: 10_000,
  });
  assert.ok(provider);

  const invalid = await provider.initiateKyc("9999 9999 9999");
  assert.deepEqual(invalid, {
    ok: false,
    detail: "Invalid Aadhaar number",
    failureKind: "rejected",
  });
  assert.equal(calls, 0);

  const initiated = await provider.initiateKyc(validAadhaar);
  assert.equal(initiated.ok, true);
  assert.equal(calls, 1);
  assert.equal(request?.redirect, "error");
  assert.ok(request?.signal instanceof AbortSignal);
  assert.equal(JSON.parse(String(request?.body)).aadhaar_number, validAadhaar);
});

test("provider responses normalize profile fields and never return Aadhaar", async () => {
  const provider = createDecentroAadhaarKycProvider({
    initiateUrl: "https://decentro.example/initiate",
    verifyUrl: "https://decentro.example/verify",
    apiKey: "decentro-test-key",
    fetchImpl: async (input) => {
      if (String(input).endsWith("/initiate")) {
        return new Response(JSON.stringify({ transaction_id: "dec-txn", masked_mobile: "******0019" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          reference_id: "dec-ref",
          data: {
            name: "Asha Patient",
            gender: "Female",
            dob: "2000-01-01",
            address: "Camp Road",
            mobile: "919876543210",
            email: "asha@example.test",
          },
        }),
        { status: 200 },
      );
    },
  });
  assert.ok(provider);

  const initiated = await provider.initiateKyc(validAadhaar);
  assert.equal(initiated.ok, true);
  if (!initiated.ok) return;
  const verified = await provider.verifyOtp(initiated.txnId, "123456");
  assert.deepEqual(verified, {
    ok: true,
    profile: {
      full_name: "Asha Patient",
      gender: "F",
      age: 26,
      address: "Camp Road",
      phone: "919876543210",
      email: "asha@example.test",
    },
    providerRef: "dec-ref",
    phone: "919876543210",
  });
  assert.equal(JSON.stringify(verified).includes(validAadhaar), false);
});

test("HTTP failures distinguish rejected, expired, and uncertain outcomes", async () => {
  const responses = [
    new Response(JSON.stringify({ message: "OTP expired" }), { status: 410 }),
    new Response("no", { status: 503 }),
  ];
  const provider = createDigioAadhaarKycProvider({
    initiateUrl: "https://digio.example/initiate",
    verifyUrl: "https://digio.example/verify",
    apiKey: "digio-test-key",
    fetchImpl: async () => responses.shift(),
  });
  assert.ok(provider);

  const expired = await provider.verifyOtp("txn-1", "123456");
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.failureKind, "expired");

  const uncertain = await provider.verifyOtp("txn-1", "123456");
  assert.equal(uncertain.ok, false);
  if (!uncertain.ok) assert.equal(uncertain.failureKind, "uncertain");
});

test("network failures are retryable and sensitive identifiers are redacted", async () => {
  const provider = createDigioAadhaarKycProvider({
    initiateUrl: "https://digio.example/initiate",
    verifyUrl: "https://digio.example/verify",
    apiKey: "digio-test-key",
    fetchImpl: async () => {
      throw new Error(`connection dropped for ${validAadhaar}`);
    },
  });
  assert.ok(provider);

  const result = await provider.initiateKyc(validAadhaar);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(validAadhaar), false);
  if (!result.ok) assert.equal(result.failureKind, "uncertain");
});
