import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/admin/sponsor-assets/route.ts";
import { DELETE } from "../src/app/api/admin/sponsor-assets/[id]/route.ts";
import { __resetCookies, __setCookies } from "./stubs/next-headers.mjs";
import {
  __resetAuthMock,
  __setAuthMock,
} from "./stubs/supabase-ssr.mjs";
import {
  __resetServiceRoleClient,
  __setServiceRoleClient,
} from "./stubs/service-role-admin.mjs";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMP_ID = "22222222-2222-4222-8222-222222222222";

function signInAdmin() {
  __setCookies([{ name: "sb-test-auth-token", value: "1" }]);
  __setAuthMock({
    userId: ADMIN_ID,
    profile: {
      id: ADMIN_ID,
      role: "admin",
      full_name: "Admin",
      disabled_at: null,
    },
  });
}

function pngFile() {
  // Minimal PNG magic
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  return new File([bytes], "logo.png", { type: "image/png" });
}

function formRequest(campId) {
  const form = new FormData();
  if (campId !== undefined) form.set("campId", campId);
  form.set("file", pngFile());
  return new Request("http://localhost/api/admin/sponsor-assets", {
    method: "POST",
    body: form,
  });
}

function lifecycleClient(options = {}) {
  const state = {
    asset: null,
    updates: [],
    cleanupDeleted: false,
    ...options,
  };
  const query = (result, onResolve) => {
    const filters = {};
    const chain = {
      eq(column, value) {
        filters[column] = value;
        return chain;
      },
      async maybeSingle() {
        return typeof result === "function" ? result(filters) : result;
      },
      then(resolve, reject) {
        return Promise.resolve(
          typeof result === "function" ? result(filters) : result,
        ).then(resolve, reject);
      },
    };
    if (onResolve) chain.then = (resolve, reject) =>
      Promise.resolve(onResolve(filters)).then(resolve, reject);
    return chain;
  };
  const mutation = (kind, values) => {
    const filters = {};
    const chain = {
      eq(column, value) {
        filters[column] = value;
        return chain;
      },
      then(resolve, reject) {
        const result = {
          error:
            kind === "delete"
              ? options.cleanupError ?? null
              : kind === "update"
                ? options.updateErrors?.shift?.() ?? null
                : null,
        };
        if (!result.error && kind === "delete") state.cleanupDeleted = true;
        if (!result.error && kind === "update") {
          state.asset = { ...state.asset, ...values };
          state.updates.push(values);
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  };
  return {
    state,
    from(table) {
      if (table === "camps") {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: { id: CAMP_ID }, error: null }) };
              },
            };
          },
        };
      }
      if (table !== "sponsor_assets") throw new Error(`unexpected table ${table}`);
      return {
        insert: async (values) => {
          state.asset = { ...values, cleanup_attempts: 0 };
          return { error: options.pendingError ?? null };
        },
        update(values) {
          return mutation("update", values);
        },
        delete() {
          return mutation("delete");
        },
        select() {
          return query(() => ({
            data: state.asset
              ? { cleanup_attempts: state.asset.cleanup_attempts ?? 0 }
              : null,
            error: null,
          }));
        },
      };
    },
    storage: {
      from() {
        return {
          upload: async () => ({ error: options.uploadError ?? null }),
          remove: async () => ({ error: options.storageError ?? null }),
        };
      },
    },
    rpc: async (fn, args) => {
      if (fn === "begin_sponsor_asset_deletion") {
        if (options.beginError) return { data: null, error: options.beginError };
        state.asset = {
          ...(state.asset ?? {}),
          id: args.p_asset_id,
          object_key: "camp/logo.png",
          state: "deleting",
        };
        return { data: options.beginData ?? { object_key: "camp/logo.png", state: "deleting" }, error: null };
      }
      if (fn === "finish_sponsor_asset_deletion") {
        return { data: null, error: options.finishError ?? null };
      }
      throw new Error(`unexpected RPC ${fn}`);
    },
  };
}

test.beforeEach(() => {
  __resetCookies();
  __resetAuthMock();
  __resetServiceRoleClient();
});

test("missing campId returns 400 and never touches storage", async () => {
  signInAdmin();
  let storageCalls = 0;
  __setServiceRoleClient({
    storage: {
      from() {
        storageCalls += 1;
        return {
          upload: async () => ({ error: null }),
          remove: async () => ({ error: null }),
        };
      },
    },
    from() {
      storageCalls += 1;
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: null, error: null }),
              };
            },
          };
        },
        insert: async () => ({ error: null }),
      };
    },
  });
  const res = await POST(formRequest(""));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, "Select a camp before uploading.");
  assert.equal(storageCalls, 0);
});

test("non-UUID campId returns 400 and never touches storage", async () => {
  signInAdmin();
  let storageCalls = 0;
  __setServiceRoleClient({
    storage: {
      from() {
        storageCalls += 1;
        return { upload: async () => ({ error: null }) };
      },
    },
    from() {
      storageCalls += 1;
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: async () => ({ data: { id: CAMP_ID }, error: null }) };
            },
          };
        },
      };
    },
  });
  const res = await POST(formRequest("not-uuid"));
  assert.equal(res.status, 400);
  assert.equal(storageCalls, 0);
});

test("upload fault plus cleanup fault leaves a pending reconciliation marker", async () => {
  signInAdmin();
  const client = lifecycleClient({
    uploadError: { message: "storage unavailable" },
    cleanupError: { message: "database unavailable" },
  });
  __setServiceRoleClient(client);
  const res = await POST(formRequest(CAMP_ID));
  assert.equal(res.status, 502);
  assert.deepEqual(client.state.updates, [{ last_error_code: "UPLOAD_OR_CLEANUP_FAILED" }]);
});

test("ready transition fault records a pending reconciliation marker", async () => {
  signInAdmin();
  const client = lifecycleClient({
    updateErrors: [{ message: "ready write failed" }, null],
  });
  __setServiceRoleClient(client);
  const res = await POST(formRequest(CAMP_ID));
  assert.equal(res.status, 502);
  assert.deepEqual(client.state.updates, [{ last_error_code: "UPLOAD_OR_CLEANUP_FAILED" }]);
});

function deleteRequest(id = "33333333-3333-4333-8333-333333333333") {
  return new Request(`http://localhost/api/admin/sponsor-assets/${id}`, {
    method: "DELETE",
  });
}

test("storage delete fault increments cleanup state and keeps deletion retryable", async () => {
  signInAdmin();
  const client = lifecycleClient({
    storageError: { message: "object storage timeout" },
  });
  __setServiceRoleClient(client);
  const res = await DELETE(deleteRequest(), {
    params: Promise.resolve({ id: "33333333-3333-4333-8333-333333333333" }),
  });
  assert.equal(res.status, 502);
  assert.deepEqual(client.state.updates, [
    { cleanup_attempts: 1, last_error_code: "STORAGE_DELETE_FAILED" },
  ]);
});

test("database finish fault leaves the deleting state for retry", async () => {
  signInAdmin();
  const client = lifecycleClient({
    finishError: { message: "database timeout" },
  });
  __setServiceRoleClient(client);
  const res = await DELETE(deleteRequest(), {
    params: Promise.resolve({ id: "33333333-3333-4333-8333-333333333333" }),
  });
  assert.equal(res.status, 502);
  assert.deepEqual(client.state.updates, []);
});
