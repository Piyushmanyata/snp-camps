/**
 * MSG91 adapter — single send function (#51).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sendMsg91TemplateSms } from "../src/lib/msg91.ts";

test("sendMsg91TemplateSms posts flow payload with authkey header", async () => {
  /** @type {RequestInit | undefined} */
  let init;
  /** @type {string | undefined} */
  let url;
  const result = await sendMsg91TemplateSms(
    {
      mobiles: "919876543210",
      templateId: "tpl-1",
      senderId: "SNPCP",
      authKey: "secret-key",
      variables: { reg: "12", date: "30 सितंबर 2026", venue: "Hall" },
    },
    {
      fetchImpl: async (input, options) => {
        url = String(input);
        init = options;
        return new Response(JSON.stringify({ request_id: "req-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.requestId, "req-1");
  assert.match(String(url), /msg91\.com/);
  assert.equal(init?.method, "POST");
  const headers = init?.headers;
  const auth =
    headers && typeof headers === "object" && "authkey" in headers
      ? headers.authkey
      : null;
  assert.equal(auth, "secret-key");
  const body = JSON.parse(String(init?.body));
  assert.equal(body.template_id, "tpl-1");
  assert.equal(body.sender, "SNPCP");
  assert.equal(body.recipients[0].mobiles, "919876543210");
  assert.equal(body.recipients[0].reg, "12");
});

test("sendMsg91TemplateSms maps HTTP errors without throwing", async () => {
  const result = await sendMsg91TemplateSms(
    {
      mobiles: "919876543210",
      templateId: "tpl-1",
      senderId: "SNPCP",
      authKey: "secret-key",
      variables: { reg: "1", date: "1 जनवरी 2026", venue: "H" },
    },
    {
      fetchImpl: async () =>
        new Response("nope", { status: 500 }),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.detail, /500/);
});
