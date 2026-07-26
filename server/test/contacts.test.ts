import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseGoogleCsv,
  parseVCard,
} from "../src/services/contacts.js";
import { createTestApp, signedWebhook, TEST_FROM_NUMBER } from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const VCARD = `BEGIN:VCARD
VERSION:3.0
FN:Jordan Rivera
TEL;TYPE=CELL:+1 555-123-4567
TEL;TYPE=HOME:(555) 222-3333
END:VCARD
BEGIN:VCARD
VERSION:3.0
N:Chen;Wei;;;
TEL;TYPE=CELL:555.987.6543
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:No Number Person
END:VCARD
`;

const GOOGLE_CSV = `Name,Given Name,Family Name,Phone 1 - Type,Phone 1 - Value,Phone 2 - Value
Jordan Rivera,Jordan,Rivera,Mobile,+1 555-123-4567,
,Wei,Chen,Mobile,(555) 987-6543 ::: 555-444-5555,
Comma Name" Test,,,Mobile,5552223333,
`;

describe("contact file parsing", () => {
  it("parses vCard entries, including folded and structured names", () => {
    const parsed = parseVCard(VCARD);
    expect(parsed).toHaveLength(2); // the third has no phone number
    expect(parsed[0]).toEqual({
      name: "Jordan Rivera",
      phones: ["+1 555-123-4567", "(555) 222-3333"],
    });
    expect(parsed[1]!.name).toBe("Wei Chen");
  });

  it("parses Google CSV, including multi-number cells", () => {
    const parsed = parseGoogleCsv(GOOGLE_CSV);
    expect(parsed[0]).toEqual({
      name: "Jordan Rivera",
      phones: ["+1 555-123-4567"],
    });
    // Falls back to given/family when the Name column is empty.
    expect(parsed[1]!.name).toBe("Wei Chen");
    expect(parsed[1]!.phones).toEqual(["(555) 987-6543", "555-444-5555"]);
  });

  it("handles quoted CSV fields", () => {
    const parsed = parseGoogleCsv(
      `Name,Phone 1 - Value\n"Rivera, Jordan",5551234567\n`,
    );
    expect(parsed[0]!.name).toBe("Rivera, Jordan");
  });
});

describe("contacts API", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  const importVCard = (body = VCARD) =>
    ctx.inject({
      method: "POST",
      url: "/api/contacts/import",
      headers: { "content-type": "text/vcard" },
      payload: body,
    });

  it("imports a vCard and normalizes every number to E.164", async () => {
    const res = await importVCard();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      contactsImported: 2,
      numbersImported: 3,
      skippedNumbers: 0,
    });

    const list = await ctx.inject({ method: "GET", url: "/api/contacts" });
    const phones = list.json().contacts.map((c: { phone: string }) => c.phone);
    expect(phones.sort()).toEqual([
      "+15551234567",
      "+15552223333",
      "+15559876543",
    ]);
  });

  it("is idempotent and updates the name on re-import", async () => {
    await importVCard();
    await importVCard(
      `BEGIN:VCARD\nFN:Jordan R. Rivera\nTEL:+15551234567\nEND:VCARD\n`,
    );
    const list = await ctx.inject({ method: "GET", url: "/api/contacts" });
    const match = list
      .json()
      .contacts.find((c: { phone: string }) => c.phone === "+15551234567");
    expect(match.name).toBe("Jordan R. Rivera");
    expect(list.json().count).toBe(3);
  });

  it("counts unparseable numbers instead of failing the import", async () => {
    const res = await importVCard(
      `BEGIN:VCARD\nFN:Weird Number\nTEL:12\nTEL:+15551234567\nEND:VCARD\n`,
    );
    expect(res.json().skippedNumbers).toBe(1);
    expect(res.json().numbersImported).toBe(1);
  });

  it("rejects an empty or unrecognizable file", async () => {
    const empty = await importVCard("   ");
    expect(empty.statusCode).toBe(400);

    const junk = await importVCard("this is not a contacts export");
    expect(junk.statusCode).toBe(400);
  });

  it("requires a session", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/contacts",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("contact name resolution", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
    await ctx.inject({
      method: "POST",
      url: "/api/contacts/import",
      headers: { "content-type": "text/vcard" },
      payload: VCARD,
    });
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  async function inboundFrom(from: string, sid: string) {
    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: sid,
        From: from,
        To: TEST_FROM_NUMBER,
        Body: "hi",
      }),
    });
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    return list.json().conversations[0];
  }

  it("names a brand-new conversation from the address book", async () => {
    const convo = await inboundFrom("+15551234567", "SM_c1");
    expect(convo.contactName).toBe("Jordan Rivera");
    expect(convo.displayName).toBeNull();
  });

  it("leaves unknown numbers unnamed", async () => {
    const convo = await inboundFrom("+15550001111", "SM_c2");
    expect(convo.contactName).toBeNull();
  });

  it("lets a per-thread rename win over the imported name", async () => {
    const convo = await inboundFrom("+15551234567", "SM_c3");
    await ctx.inject({
      method: "PATCH",
      url: `/api/conversations/${convo.id}`,
      payload: { displayName: "Jordy" },
    });
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    expect(list.json().conversations[0].displayName).toBe("Jordy");
    expect(list.json().conversations[0].contactName).toBe("Jordy");
  });

  it("uses the contact name for push notifications", async () => {
    await ctx.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: {
        endpoint: "https://push.example.test/c1",
        keys: { p256dh: "k", auth: "a" },
      },
    });
    await inboundFrom("+15551234567", "SM_c4");
    await new Promise((r) => setTimeout(r, 50));
    const payload = JSON.parse(ctx.pushSender.sent.at(-1)!.payload) as {
      title: string;
    };
    expect(payload.title).toBe("Jordan Rivera");
  });

  it("clears names when the address book is emptied", async () => {
    await inboundFrom("+15551234567", "SM_c5");
    await ctx.inject({ method: "DELETE", url: "/api/contacts" });
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    expect(list.json().conversations[0].contactName).toBeNull();
  });
});
