import { getStore } from "@netlify/blobs";
import { checkEntitlement } from "../lib/entitlement.mjs";

// Records the deterministic daily top-9 + #1 pick for later forward-testing (comparing
// the deterministic pick, and eventually the AI bracket's pick, against actual subsequent
// price performance). First write for a given date wins -- later scans that same day are
// no-ops, so the log reflects the first canonical scan of the day, not whichever visitor
// happened to scan last.
export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Requires login (blocks anonymous scripted spam) but not an active subscription --
  // this writes one global, first-write-wins record with no paid API call and no
  // proprietary data returned, so subscription-gating it adds no security value.
  const ent = await checkEntitlement(req, { authOnly: true });
  if (!ent.ok) {
    return new Response(JSON.stringify({ error: ent.error }), {
      status: ent.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { date, candidates, topPick } = body;
    if (!date || !Array.isArray(candidates) || candidates.length === 0 || !topPick) {
      return new Response(JSON.stringify({ error: "Invalid payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const store = getStore({ name: "daily-snapshots", consistency: "strong" });

    const existing = await store.get(date, { type: "json" });
    if (existing) {
      return new Response(JSON.stringify({ saved: false, reason: "already exists" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    await store.setJSON(date, { date, candidates, topPick, savedAt: new Date().toISOString() });

    return new Response(JSON.stringify({ saved: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Function error", detail: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
