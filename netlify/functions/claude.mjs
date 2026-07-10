import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "API key not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    // cacheKey is only set by the frontend when the user is on default DCF/risk inputs --
    // in that case every user's top-10 candidate list is identical for the day, so one real
    // Anthropic call can serve everyone instead of one call per click.
    const cacheKey = body.cacheKey || null;
    const store = cacheKey ? getStore({ name: "ai-analysis-cache", consistency: "strong" }) : null;

    if (store) {
      const cached = await store.get(cacheKey, { type: "json" });
      if (cached) {
        return new Response(JSON.stringify({ ...cached, _servedFromCache: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4096,
        messages: body.messages,
      }),
    });

    const data = await response.json();

    if (store && response.ok && !data.error) {
      await store.setJSON(cacheKey, data);
    }

    return new Response(JSON.stringify({ ...data, _servedFromCache: false }), {
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
