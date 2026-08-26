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
        if (table === "deferred_slips") {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq: async () => ({ data: [], error: null }),
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
                        return {
                          eq: async () => ({ data: [], error: null }),
                        };
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
                        return {
                          eq: async () => ({
                            data: null,
                            error: { message: "relation missing" },
                          }),
                        };
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

test("cron returns non-2xx for rejected and ambiguous provider outcomes", async () => {
  const previous = {
    key: process.env.MSG91_AUTH_KEY,
    sender: process.env.MSG91_SENDER_ID,
    template: process.env.MSG91_TEMPLATE_REMINDER,
    fetch: globalThis.fetch,
  };
  process.env.MSG91_AUTH_KEY = "key";
  process.env.MSG91_SENDER_ID = "SNPCMP";
  process.env.MSG91_TEMPLATE_REMINDER = "reminder-template";

  function providerClient() {
    return {
      from(table) {
        if (table === "sms_deliveries") {
          return {
            select() {
              return {
                eq() {
                  return { in: async () => ({ data: [], error: null }) };
                },
              };
            },
          };
        }
        if (table === "deferred_slips") {
          return {
            select() {
              return {
                eq() {
                  return { eq: async () => ({ data: [], error: null }) };
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
                        return {
                          eq: async () => ({
                            data: [
                              {
                                id: "patient-provider",
                                reg_no: 1501,
                                phone: "9876543210",
                                queue_status: "registered",
                                reminder_sms_sent_at: null,
                                camp_days: { day_date: "2026-08-27" },
                                camps: { venue: "Hall", is_active: true },
                              },
                            ],
                            error: null,
                          }),
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      async rpc(fn) {
        if (fn === "claim_sms_delivery") {
          return {
            data: { delivery_id: "delivery-provider", claim_token: "token-provider" },
            error: null,
          };
        }
        if (fn === "prune_sms_deliveries") return { data: 0, error: null };
        return { data: true, error: null };
      },
    };
  }

  try {
    await withCronSecret("super-secret", async () => {
      const cases = [
        {
          counter: "failed",
          fetch: async () => new Response("bad request", { status: 400 }),
        },
        {
          counter: "ambiguous",
          fetch: async () => {
            throw new Error("fetch failed");
          },
        },
      ];
      for (const scenario of cases) {
        __setServiceRoleClient(providerClient());
        globalThis.fetch = scenario.fetch;
        const res = await POST(
          new Request("http://local/api/cron/reminder-sms", {
            method: "POST",
            headers: { authorization: "Bearer super-secret" },
          }),
        );
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body[scenario.counter], 1);
        assert.equal(body.deferral.ok, true);
      }
    });
  } finally {
    __resetServiceRoleClient();
    globalThis.fetch = previous.fetch;
    if (previous.key === undefined) delete process.env.MSG91_AUTH_KEY;
    else process.env.MSG91_AUTH_KEY = previous.key;
    if (previous.sender === undefined) delete process.env.MSG91_SENDER_ID;
    else process.env.MSG91_SENDER_ID = previous.sender;
    if (previous.template === undefined) delete process.env.MSG91_TEMPLATE_REMINDER;
    else process.env.MSG91_TEMPLATE_REMINDER = previous.template;
  }
});
