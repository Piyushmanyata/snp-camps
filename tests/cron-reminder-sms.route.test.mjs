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
      from() {
        const chain = {
          select() {
            return chain;
          },
          eq() {
            return chain;
          },
          is() {
            return chain;
          },
          not() {
            return chain;
          },
          then(resolve) {
            resolve({ data: [], error: null });
          },
        };
        // Make awaitable terminal: last .eq returns a thenable
        chain.eq = function eq() {
          return {
            then(resolve) {
              resolve({ data: [], error: null });
            },
            eq: chain.eq,
            is: chain.is,
            not: chain.not,
            select: chain.select,
          };
        };
        return {
          select() {
            return {
              eq() {
                return {
                  is() {
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
          update() {
            return {
              eq() {
                return {
                  is() {
                    return {
                      select() {
                        return {
                          maybeSingle: async () => ({ data: null, error: null }),
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
