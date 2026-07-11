import { createClient } from "@supabase/supabase-js";

let adminClient = null;
export function getAdminClient() {
  if (!adminClient) {
    adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return adminClient;
}

// Looks up a subscribers row for an authenticated Supabase user. Falls back to an email
// match (and backfills user_id) because the Stripe webhook can create the row before the
// user ever signs in for the first time -- the same race the webhook itself may not have
// resolved yet.
export async function lookupSubscriber(user) {
  const admin = getAdminClient();
  let { data: sub } = await admin.from("subscribers").select("*").eq("user_id", user.id).maybeSingle();
  if (!sub && user.email) {
    const { data: byEmail } = await admin.from("subscribers").select("*").eq("email", user.email).maybeSingle();
    if (byEmail) {
      sub = byEmail;
      if (!byEmail.user_id) {
        await admin
          .from("subscribers")
          .update({ user_id: user.id, updated_at: new Date().toISOString() })
          .eq("id", byEmail.id);
      }
    }
  }
  return sub || null;
}

// Every trial grants full Premium-level access regardless of which tier was actually
// purchased -- only once the trial ends does entitlement narrow to the subscribed tier.
function effectiveTierFor(sub) {
  if (!sub) return null;
  return sub.status === "trialing" ? "premium" : sub.tier;
}

// authOnly: caller just needs a valid session (e.g. save-snapshot -- no paid API call,
// no proprietary data returned, so subscription status doesn't matter, only that it isn't
// anonymous). requireTier: 'premium' additionally requires premium-level entitlement.
export async function checkEntitlement(req, { authOnly = false, requireTier = null } = {}) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, status: 401, error: "Missing Authorization bearer token" };

  const admin = getAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return { ok: false, status: 401, error: "Invalid or expired session" };
  const user = data.user;

  if (authOnly) return { ok: true, user, subscriber: null, tier: null };

  const sub = await lookupSubscriber(user);
  if (!sub) return { ok: false, status: 402, error: "No subscription found" };

  const activeLike = sub.status === "active" || sub.status === "trialing";
  if (!activeLike) return { ok: false, status: 402, error: `Subscription status: ${sub.status}` };

  const tier = effectiveTierFor(sub);
  if (requireTier === "premium" && tier !== "premium") {
    return { ok: false, status: 403, error: "Premium tier required" };
  }

  return { ok: true, user, subscriber: sub, tier };
}

export { effectiveTierFor };
