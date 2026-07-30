/**
 * Cron endpoint auth for day-before reminder SMS (#52).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../src/app/api/cron/reminder-sms/route.ts";
import {
  __resetServiceRoleClient,
  __setServiceRoleClient,
} from "./stubs/service-role-admin.mjs";

function withCronSecret(secret, fn) {
  const prev = process.env.CRON_SECRET;
  if (secret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = secret;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    });
}

test("cron rejects unauthenticated calls", async () => {
  await withCronSecret("super-secret", async () => {
    const bare = await GET(new Request("http://local/api/cron/reminder-sms"));
    assert.equal(bare.status, 401);

    const wrong = await GET(
      new Request("http://local/api/cron/reminder-sms", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    assert.equal(wrong.status, 401);

    const missingSecret = await withCronSecret(undefined, async () => {
      return GET(
        new Request("http://local/api/cron/reminder-sms", {
          headers: { authorization: "Bearer super-secret" },
        }),
      );
    });
    assert.equal(missingSecret.status, 401);
  });
});

test("cron with valid secret runs job (empty candidates)", async () => {
  await withCronSecret("super-secret", async () => {
    __setServiceRoleClient({
      from(table) {
        if (table === "sms_deliveries") {
          return {
            select() {
              return {
                eq() {
                  return {
                    in: async () => ({ data: [], error: null }),
                  };
                },
              };
            },
          };
        }
        return {
          select() {
            return {
              eq() {
                return {
                  not() {
                    return {
                      eq() {
                        return Promise.resolve({ data: [], error: null });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      rpc: async (fn) => {
        if (fn === "prune_sms_deliveries") return { data: 0, error: null };
        return { data: null, error: null };
      },
    });

    try {
      const res = await POST(
        new Request("http://local/api/cron/reminder-sms", {
          method: "POST",
          headers: { authorization: "Bearer super-secret" },
        }),
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.sent, 0);
      assert.ok(typeof body.tomorrow === "string");
    } finally {
      __resetServiceRoleClient();
    }
  });
});

test("cron list failure returns non-2xx and ok:false", async () => {
  await withCronSecret("super-secret", async () => {
    __setServiceRoleClient({
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  not() {
                    return {
                      eq() {
                        return Promise.resolve({
                          data: null,
                          error: { message: "relation missing" },
                        });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      rpc: async () => ({ data: null, error: null }),
    });
    try {
      const res = await POST(
        new Request("http://local/api/cron/reminder-sms", {
          method: "POST",
          headers: { authorization: "Bearer super-secret" },
        }),
      );
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(String(body.error), /relation missing|list/i);
    } finally {
      __resetServiceRoleClient();
    }
  });
});
