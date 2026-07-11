import { checkEntitlement, lookupSubscriber, effectiveTierFor } from "../lib/entitlement.mjs";

// Unlike checkEntitlement's gating use elsewhere, this must return 200 even when the
// caller has no subscription at all -- the frontend uses that to render the pricing
// screen rather than treat it as an error.
export default async (req) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const ent = await checkEntitlement(req, { authOnly: true });
  if (!ent.ok) {
    return new Response(JSON.stringify({ error: ent.error }), {
      status: ent.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sub = await lookupSubscriber(ent.user);
  const activeLike = sub && (sub.status === "active" || sub.status === "trialing");
  const effectiveTier = activeLike ? effectiveTierFor(sub) : "none";

  return new Response(
    JSON.stringify({
      email: ent.user.email,
      subscriber: sub
        ? {
            tier: sub.tier,
            status: sub.status,
            trialEndsAt: sub.trial_ends_at,
            currentPeriodEnd: sub.current_period_end,
          }
        : null,
      effectiveTier,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};
