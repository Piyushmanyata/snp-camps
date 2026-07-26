import assert from "node:assert/strict";
import test from "node:test";
import { POST as initiate } from "../src/app/api/aadhaar-kyc/initiate/route.ts";
import { POST as verify } from "../src/app/api/aadhaar-kyc/verify/route.ts";
import {
  beginAadhaarKycVerification,
  consumeVerifiedAadhaarKycSession,
  createAadhaarKycSession,
  finishAadhaarKycVerification,
  hashAadhaar,
  resetAadhaarKycSessionsForTests,
} from "../src/lib/aadhaar-kyc-session.ts";

const validAadhaar = "999999990019";

function request(path, body, ip) {
  return new Request(`http://local/api/aadhaar-kyc/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

async function withKycEnv(fn, options = {}) {
  const pepper = Object.hasOwn(options, "pepper") ? options.pepper : "test-pepper";
  const provider = Object.hasOwn(options, "provider") ? options.provider : "mock";
  const previous = {
    pepper: process.env.AADHAAR_KYC_PEPPER,
    legacyPepper: process.env.AADHAAR_PEPPER,
    provider: process.env.AADHAAR_KYC_PROVIDER,
  };
  if (pepper === undefined) delete process.env.AADHAAR_KYC_PEPPER;
  else process.env.AADHAAR_KYC_PEPPER = pepper;
  delete process.env.AADHAAR_PEPPER;
  if (provider === undefined) delete process.env.AADHAAR_KYC_PROVIDER;
  else process.env.AADHAAR_KYC_PROVIDER = provider;
  try {
    return await fn();
  } finally {
    if (previous.pepper === undefined) delete process.env.AADHAAR_KYC_PEPPER;
    else process.env.AADHAAR_KYC_PEPPER = previous.pepper;
    if (previous.legacyPepper === undefined) delete process.env.AADHAAR_PEPPER;
    else process.env.AADHAAR_PEPPER = previous.legacyPepper;
    if (previous.provider === undefined) delete process.env.AADHAAR_KYC_PROVIDER;
    else process.env.AADHAAR_KYC_PROVIDER = previous.provider;
  }
}

test("session stores only a keyed Aadhaar digest and consumes verified data once", () => {
  resetAadhaarKycSessionsForTests();
  const created = createAadhaarKycSession({
    txnId: "server-only-txn",
    aadhaarDigits: validAadhaar,
    pepper: "pepper",
    now: 1_000,
  });
  assert.notEqual(created.handle, "server-only-txn");
  assert.equal(hashAadhaar(validAadhaar, "pepper").length, 64);
  assert.equal(JSON.stringify(created).includes(validAadhaar), false);
  const pending = beginAadhaarKycVerification(created.handle, 1_001);
  assert.equal(pending.status, "pending");
  assert.equal(
    finishAadhaarKycVerification({
      handle: created.handle,
      profile: { full_name: "Test Patient" },
      providerRef: "provider-ref",
      phone: "9876543210",
    }),
    true,
  );
  const consumed = consumeVerifiedAadhaarKycSession(created.handle, 1_002);
  assert.equal(consumed?.aadhaarLast4, "0019");
  assert.equal(consumed?.aadhaarHash, hashAadhaar(validAadhaar, "pepper"));
  assert.equal(consumeVerifiedAadhaarKycSession(created.handle, 1_003), null);
});

test("initiate is explicitly unavailable without provider or pepper", async () => {
  resetAadhaarKycSessionsForTests();
  await withKycEnv(
    async () => {
      const res = await initiate(request("initiate", { aadhaar: validAadhaar }, "198.51.100.11"));
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), {
        available: false,
        status: "unavailable",
        error: "Aadhaar eKYC is not available. Please use the camp desk.",
      });
    },
    { pepper: undefined },
  );
});

test("initiate validates Aadhaar before the provider and returns only an opaque handle", async () => {
  resetAadhaarKycSessionsForTests();
  await withKycEnv(async () => {
    const invalid = await initiate(
      request("initiate", { aadhaar: "999999999999" }, "198.51.100.12"),
    );
    assert.equal(invalid.status, 400);

    const res = await initiate(
      request("initiate", { aadhaar: validAadhaar }, "198.51.100.13"),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.handle, /^[A-Za-z0-9_-]{40,64}$/);
    assert.equal(body.txnId, undefined);
    assert.equal(JSON.stringify(body).includes(validAadhaar), false);
  });
});

test("verify distinguishes rejection and successful verification is not reusable", async () => {
  resetAadhaarKycSessionsForTests();
  await withKycEnv(async () => {
    const started = await initiate(
      request("initiate", { aadhaar: validAadhaar }, "198.51.100.14"),
    );
    const { handle } = await started.json();

    const rejected = await verify(
      request("verify", { handle, otp: "000000" }, "198.51.100.15"),
    );
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).failureKind, "rejected");

    const secondStart = await initiate(
      request("initiate", { aadhaar: validAadhaar }, "198.51.100.16"),
    );
    const second = await secondStart.json();
    const verified = await verify(
      request("verify", { handle: second.handle, otp: "123456" }, "198.51.100.17"),
    );
    assert.equal(verified.status, 200);
    const verifiedBody = await verified.json();
    assert.equal(verifiedBody.ok, true);
    assert.equal(verifiedBody.profile.full_name, "Aadhaar Test Patient");
    assert.equal(verifiedBody.txnId, undefined);
    assert.equal(JSON.stringify(verifiedBody).includes(validAadhaar), false);

    const reused = await verify(
      request("verify", { handle: second.handle, otp: "123456" }, "198.51.100.18"),
    );
    assert.equal(reused.status, 409);
    assert.equal((await reused.json()).failureKind, "rejected");
  });
});
