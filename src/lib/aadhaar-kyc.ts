import {
  ageFromDob,
  digitsOnly,
  isValidAadhaarNumber,
  normalizeGender,
  type AadhaarProfile,
} from "@/lib/aadhaar";
import { sensitiveProviderUrl } from "@/lib/provider-url";

export type AadhaarKycProvider = {
  initiateKyc: (
    aadhaarDigits: string,
  ) => Promise<
    | { ok: true; txnId: string; maskedMobile: string | null }
    | { ok: false; detail: string; failureKind: "rejected" | "uncertain" }
  >;
  verifyOtp: (
    txnId: string,
    otp: string,
  ) => Promise<
    | {
        ok: true;
        profile: AadhaarProfile;
        providerRef: string;
        phone: string | null;
      }
    | {
        ok: false;
        detail: string;
        failureKind: "rejected" | "uncertain" | "expired";
      }
  >;
};

type Environment = Record<string, string | undefined>;

export type AadhaarKycAdapterConfig = {
  initiateUrl?: string;
  verifyUrl?: string;
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  headers?: HeadersInit;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type MockAadhaarKycOptions = {
  expectedOtp?: string;
  expiredOtp?: string;
  txnId?: string;
  maskedMobile?: string | null;
  phone?: string | null;
  profile?: AadhaarProfile;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 15_000;

function boundedTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs as number)));
}

function redactSensitive(value: string): string {
  return value
    .replace(/\b\d{12}\b/g, "[redacted]")
    .replace(/\b\d{4}(?:[ -]\d{4}){2}\b/g, "[redacted]");
}

function detailFromError(error: unknown): string {
  const detail = error instanceof Error ? error.message : "Provider request failed";
  return redactSensitive(detail).slice(0, 200);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nestedPayload(value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  return asRecord(root.data ?? root.result ?? root.kyc ?? root.profile ?? root);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 256);
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d{1,3}$/.test(value.trim())) {
      return Number(value.trim());
    }
  }
  return null;
}

function responseText(body: unknown): string {
  const root = asRecord(body);
  return [root.code, root.status, root.message, root.error, root.detail]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function isExpiredResponse(status: number, body: unknown): boolean {
  return status === 410 || /expired|otp[_ -]?timeout/.test(responseText(body));
}

function failureForResponse(
  status: number,
  body: unknown,
  operation: "initiate" | "verify",
): { ok: false; detail: string; failureKind: "rejected" | "uncertain" | "expired" } {
  if (operation === "verify" && isExpiredResponse(status, body)) {
    return { ok: false, detail: "Aadhaar OTP expired", failureKind: "expired" };
  }

  const detail = `Aadhaar KYC HTTP ${status}`;
  return {
    ok: false,
    detail,
    failureKind: status === 408 || status >= 500 ? "uncertain" : "rejected",
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: redactSensitive(text).slice(0, 200) };
  }
}

function makeHeaders(config: AadhaarKycAdapterConfig): Headers {
  const headers = new Headers(config.headers);
  headers.set("Content-Type", "application/json");
  const apiKey = config.apiKey?.trim();
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  if (config.clientId?.trim()) headers.set("X-Client-Id", config.clientId.trim());
  if (config.clientSecret?.trim()) {
    headers.set("X-Client-Secret", config.clientSecret.trim());
  }
  return headers;
}

function configuredUrl(value: string | undefined): string | null {
  return sensitiveProviderUrl(value);
}

function hasCredentials(config: AadhaarKycAdapterConfig): boolean {
  return Boolean(
    config.apiKey?.trim() ||
      (config.clientId?.trim() && config.clientSecret?.trim()),
  );
}

function cleanProfile(payload: unknown): { profile: AadhaarProfile; phone: string | null } | null {
  const raw = nestedPayload(payload);
  const dob = firstString(raw.dob, raw.date_of_birth, raw.dateOfBirth);
  const phone = firstString(raw.phone, raw.mobile, raw.mobile_number, raw.mobileNumber);
  const profile: AadhaarProfile = {
    full_name: firstString(raw.full_name, raw.fullName, raw.name),
    gender: normalizeGender(firstString(raw.gender, raw.sex)),
    age: firstNumber(raw.age) ?? ageFromDob(dob),
    address: firstString(raw.address, raw.address_text, raw.addressText),
    phone,
    email: firstString(raw.email, raw.email_address, raw.emailAddress),
  };

  if (!profile.full_name && !profile.address && !profile.phone) return null;
  return { profile, phone };
}

function createHttpProvider(
  config: AadhaarKycAdapterConfig,
): AadhaarKycProvider | null {
  const initiateUrl = configuredUrl(config.initiateUrl);
  const verifyUrl = configuredUrl(config.verifyUrl);
  if (!initiateUrl || !verifyUrl || !hasCredentials(config)) return null;

  const fetchImpl = config.fetchImpl ?? fetch;
  const headers = makeHeaders(config);
  const timeoutMs = boundedTimeout(config.timeoutMs);

  type RequestResult =
    | { response: Response; payload: unknown }
    | { error: string };

  async function request(
    url: string,
    body: Record<string, string>,
  ): Promise<RequestResult> {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await readJson(response);
      return { response, payload };
    } catch (error) {
      return { error: detailFromError(error) };
    }
  }

  return {
    async initiateKyc(aadhaarInput) {
      const aadhaarDigits = digitsOnly(aadhaarInput);
      if (!isValidAadhaarNumber(aadhaarDigits)) {
        return {
          ok: false,
          detail: "Invalid Aadhaar number",
          failureKind: "rejected",
        };
      }

      const result = await request(initiateUrl, { aadhaar_number: aadhaarDigits });
      if ("error" in result) {
        return { ok: false, detail: result.error, failureKind: "uncertain" };
      }
      if (!result.response.ok) {
        const failure = failureForResponse(
          result.response.status,
          result.payload,
          "initiate",
        );
        if (failure.failureKind === "expired") {
          return { ok: false, detail: failure.detail, failureKind: "rejected" };
        }
        return {
          ok: false,
          detail: failure.detail,
          failureKind: failure.failureKind,
        };
      }

      const root = asRecord(result.payload);
      const payload = nestedPayload(result.payload);
      const txnId = firstString(
        payload.txn_id,
        payload.txnId,
        payload.transaction_id,
        payload.transactionId,
        payload.request_id,
        payload.requestId,
        payload.id,
        root.txn_id,
        root.txnId,
        root.transaction_id,
        root.transactionId,
        root.request_id,
        root.requestId,
        root.id,
      );
      if (!txnId) {
        return {
          ok: false,
          detail: "Aadhaar KYC response missing transaction id",
          failureKind: "uncertain",
        };
      }
      const maskedMobile = firstString(
        payload.masked_mobile,
        payload.maskedMobile,
        payload.mobile_masked,
        root.masked_mobile,
        root.maskedMobile,
        root.mobile_masked,
      );
      return {
        ok: true,
        txnId,
        maskedMobile: maskedMobile ? redactSensitive(maskedMobile) : null,
      };
    },

    async verifyOtp(txnId, otp) {
      if (!txnId.trim() || txnId.length > 256 || !/^\d{6}$/.test(otp)) {
        return {
          ok: false,
          detail: "Invalid Aadhaar OTP or transaction",
          failureKind: "rejected",
        };
      }

      const result = await request(verifyUrl, { txn_id: txnId, otp });
      if ("error" in result) {
        return { ok: false, detail: result.error, failureKind: "uncertain" };
      }
      if (!result.response.ok) {
        return failureForResponse(result.response.status, result.payload, "verify");
      }

      const cleaned = cleanProfile(result.payload);
      if (!cleaned) {
        return {
          ok: false,
          detail: "Aadhaar KYC response missing demographics",
          failureKind: "uncertain",
        };
      }
      const root = asRecord(result.payload);
      const payload = nestedPayload(result.payload);
      const providerRef = firstString(
        payload.provider_ref,
        payload.providerRef,
        payload.reference_id,
        payload.referenceId,
        payload.id,
        payload.transaction_id,
        payload.transactionId,
        root.provider_ref,
        root.providerRef,
        root.reference_id,
        root.referenceId,
        root.id,
        root.transaction_id,
        root.transactionId,
      );
      if (!providerRef) {
        return {
          ok: false,
          detail: "Aadhaar KYC response missing provider reference",
          failureKind: "uncertain",
        };
      }
      return {
        ok: true,
        profile: cleaned.profile,
        providerRef: redactSensitive(providerRef),
        phone: cleaned.phone,
      };
    },
  };
}

export function createDigioAadhaarKycProvider(
  config: AadhaarKycAdapterConfig = {},
): AadhaarKycProvider | null {
  return createHttpProvider(config);
}

export function createDecentroAadhaarKycProvider(
  config: AadhaarKycAdapterConfig = {},
): AadhaarKycProvider | null {
  return createHttpProvider(config);
}

export function createMockAadhaarKycProvider(
  options: MockAadhaarKycOptions = {},
): AadhaarKycProvider {
  const expectedOtp = options.expectedOtp ?? "123456";
  const expiredOtp = options.expiredOtp ?? "999999";
  const txnId = options.txnId ?? "mock-kyc-txn";
  const phone = options.phone ?? "919876543210";
  const profile: AadhaarProfile = {
    full_name: "Aadhaar Test Patient",
    gender: "F",
    age: 30,
    address: "Mock Aadhaar Address",
    phone,
    email: "mock@example.test",
    ...options.profile,
  };

  return {
    async initiateKyc(aadhaarInput) {
      if (!isValidAadhaarNumber(digitsOnly(aadhaarInput))) {
        return {
          ok: false,
          detail: "Invalid Aadhaar number",
          failureKind: "rejected",
        };
      }
      return {
        ok: true,
        txnId,
        maskedMobile: options.maskedMobile ?? "******3210",
      };
    },
    async verifyOtp(receivedTxnId, otp) {
      if (receivedTxnId !== txnId || otp === expiredOtp) {
        return {
          ok: false,
          detail: otp === expiredOtp ? "Mock OTP expired" : "Mock transaction expired",
          failureKind: otp === expiredOtp ? "expired" : "rejected",
        };
      }
      if (otp !== expectedOtp) {
        return { ok: false, detail: "Mock OTP rejected", failureKind: "rejected" };
      }
      return {
        ok: true,
        profile: { ...profile, phone },
        providerRef: "mock-provider-ref",
        phone,
      };
    },
  };
}

function envValue(env: Environment, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function getAadhaarKycProvider(options: {
  env?: Environment;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): AadhaarKycProvider | null {
  const env = options.env ?? process.env;
  const selection = envValue(env, "AADHAAR_KYC_PROVIDER")?.toLowerCase();
  if (selection === "mock") return createMockAadhaarKycProvider();

  if (selection === "digio") {
    return createDigioAadhaarKycProvider({
      initiateUrl: envValue(
        env,
        "AADHAAR_KYC_DIGIO_INITIATE_URL",
        "AADHAAR_KYC_DIGIO_URL",
      ),
      verifyUrl: envValue(
        env,
        "AADHAAR_KYC_DIGIO_VERIFY_URL",
        "AADHAAR_KYC_DIGIO_URL",
      ),
      apiKey: envValue(env, "AADHAAR_KYC_DIGIO_API_KEY"),
      clientId: envValue(env, "AADHAAR_KYC_DIGIO_CLIENT_ID"),
      clientSecret: envValue(env, "AADHAAR_KYC_DIGIO_CLIENT_SECRET"),
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  }

  if (selection === "decentro") {
    return createDecentroAadhaarKycProvider({
      initiateUrl: envValue(
        env,
        "AADHAAR_KYC_DECENTRO_INITIATE_URL",
        "AADHAAR_KYC_DECENTRO_URL",
      ),
      verifyUrl: envValue(
        env,
        "AADHAAR_KYC_DECENTRO_VERIFY_URL",
        "AADHAAR_KYC_DECENTRO_URL",
      ),
      apiKey: envValue(env, "AADHAAR_KYC_DECENTRO_API_KEY"),
      clientId: envValue(env, "AADHAAR_KYC_DECENTRO_CLIENT_ID"),
      clientSecret: envValue(env, "AADHAAR_KYC_DECENTRO_CLIENT_SECRET"),
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  }

  return null;
}
