// Campaigns end to end (decision 0053): acceptance sentences 31 to 34 over MCP and the board against the real Worker and
// the fake seed, plus the public paths. The Worker is started with fake campaign switches so the review page offers
// Approve. Resend is never reached: its address is fixed in src/campaigns/resend.ts, the only sender is the campaign cron,
// and this file never runs the cron, so Approve stops at "sending" with its recipient rows.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import { connectHttp, ok } from "../helpers/mcp-client.ts";
import { type DevServer, startDevServer } from "./harness.ts";

let server: DevServer;
let client: Client;

before(async () => {
  server = await startDevServer({
    extraVars: [
      "CAMPAIGN_SENDING:on",
      "CAMPAIGN_FROM:News <news@news.example.com>",
      "CAMPAIGN_RESEND_API_KEY:re_fake_e2e",
      "OWNER_EMAILS:owner@example.com",
    ],
  });
  client = await connectHttp(`${server.url}/mcp`);
});

after(async () => {
  await client?.close();
  await server?.stop();
});

type Campaign = {
  status: string;
  review_url: string;
  recipients: Record<string, number>;
  skipped_by_reason: Record<string, number>;
};

const getCampaign = async (id: string): Promise<Campaign> => (await ok(client, "get_campaign", { id })).data as Campaign;

const draft = async (args: Record<string, unknown>): Promise<{ changeId: string; campaignId: string; review_url: string; headline: string }> => {
  const answer = await ok(client, "add_campaign_draft", args);
  return { ...(answer.data as { changeId: string; campaignId: string; review_url: string }), headline: answer.headline };
};

let openHouseId = "";
let withUnsubscribedId = "";

describe("the campaign sentences", () => {
  test('31. "Set up a newsletter to my Partners about the open house, with a button to RSVP."', async () => {
    const saved = await draft({
      name: "Open house newsletter",
      recipients: { kind: "status", status: "partner" },
      subject: "You're invited to our open house, {{first_name}}",
      body: "Hi {{first_name}},\n\nWe're holding an open house and would love to see you there.",
      buttonLabel: "RSVP",
      buttonUrl: "https://example.com/rsvp",
    });
    openHouseId = saved.campaignId;
    assert.match(saved.changeId, /^chg_[a-z0-9]{12}$/);
    assert.match(saved.headline, /chg_[a-z0-9]{12}\)?$/);
    assert.match(saved.review_url, /\/campaigns\/cp_[a-z0-9]+$/);
    assert.ok(saved.review_url.endsWith(`/campaigns/${openHouseId}`));

    const page = await fetch(`${server.url}/campaigns/${openHouseId}`);
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.match(text, /You(?:'|&#39;|&#x27;)re invited to our open house/);
    assert.match(text, /Approve and send/);
  });

  test('32. "Who would get it?"', async () => {
    const answer = await ok(client, "preview_campaign_recipients", { id: openHouseId });
    const data = answer.data as { sendable: number; skipped: Record<string, number> };
    assert.equal(typeof data.sendable, "number");
    assert.ok(data.sendable >= 1, "the seed's partner is sendable");
    assert.equal(typeof data.skipped, "object");
    assert.doesNotMatch(JSON.stringify(answer), /@/, "no email address anywhere in the answer");
  });

  test('33. "Send it." has no tool: the AI app can only save drafts', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.deepEqual(names.filter((name) => /send|schedule|approve|unsubscribe|suppress/.test(name)), []);
    assert.deepEqual(names.filter((name) => /campaign/.test(name) && /pause|cancel|resume/.test(name)), []);
    assert.deepEqual(
      names.filter((name) => /campaign/.test(name)).sort(),
      ["add_campaign_draft", "get_campaign", "list_campaigns", "preview_campaign_recipients", "update_campaign_draft"],
    );
    assert.equal((await getCampaign(openHouseId)).status, "draft");
  });

  test('34. "Is anyone skipped because they unsubscribed?"', async () => {
    const saved = await draft({
      name: "Thanks to two people",
      recipients: { kind: "people", people: ["ct_seed01", "ct_seed08"] },
      subject: "Thank you, {{first_name}}",
      body: "Hi {{first_name}},\n\nThank you for your trust.",
    });
    withUnsubscribedId = saved.campaignId;
    const answer = await ok(client, "preview_campaign_recipients", { id: withUnsubscribedId });
    const data = answer.data as { sendable: number; skipped: Record<string, number> };
    assert.equal(data.skipped.unsubscribed, 1);
    assert.equal(data.sendable, 1);
    assert.doesNotMatch(JSON.stringify(answer), /@/);
  });
});

describe("the public paths", () => {
  test("the test unsubscribe link says it is from a test email", async () => {
    const res = await fetch(`${server.url}/unsubscribe/test`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /This link is from a test email\./);
  });

  test("a malformed unsubscribe token is a 404", async () => {
    const res = await fetch(`${server.url}/unsubscribe/not-a-real-token`);
    assert.equal(res.status, 404);
    await res.body?.cancel();
  });

  test("the Resend webhook without its secret is a 503, and a GET is a 405", async () => {
    const post = await fetch(`${server.url}/hooks/resend`, { method: "POST", body: "{}" });
    assert.equal(post.status, 503);
    await post.body?.cancel();
    const get = await fetch(`${server.url}/hooks/resend`);
    assert.equal(get.status, 405);
    await get.body?.cancel();
  });
});

describe("Approve on the board", () => {
  test("approving a small hand-picked draft freezes its recipients and leaves it sending, with nothing sent", async () => {
    const saved = await draft({
      name: "Approve me",
      recipients: { kind: "people", people: ["ct_seed01", "ct_seed03"] },
      subject: "Thank you, {{first_name}}",
      body: "Hi {{first_name}},\n\nThank you for the introduction.",
    });
    const page = await fetch(`${server.url}${new URL(saved.review_url).pathname}`);
    assert.equal(page.status, 200);
    const cookie = (page.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const text = await page.text();
    const token = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(text)?.[1] ?? "";
    const print = /<input type="hidden" name="fingerprint" value="([^"]+)">/.exec(text)?.[1] ?? "";
    assert.match(text, /Approve and send to 2 people/);
    assert.ok(token !== "" && print !== "");

    const posted = await fetch(`${server.url}/campaigns/${saved.campaignId}/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: server.url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: token, fingerprint: print, return_to: `/campaigns/${saved.campaignId}` }).toString(),
    });
    assert.equal(posted.status, 303, await posted.text());
    assert.match(posted.headers.get("Location") ?? "", new RegExp(`^/campaigns/${saved.campaignId}\\?change=chg_`));

    const after = await getCampaign(saved.campaignId);
    assert.equal(after.status, "sending");
    assert.equal(Object.values(after.recipients).reduce((sum, n) => sum + n, 0), 2);
  });
});
