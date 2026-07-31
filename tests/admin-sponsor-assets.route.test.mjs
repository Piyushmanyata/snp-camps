import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/admin/sponsor-assets/route.ts";
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
