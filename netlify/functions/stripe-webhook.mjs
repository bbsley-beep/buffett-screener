import Stripe from "stripe";
import { getAdminClient } from "../lib/entitlement.mjs";

const TIER_BY_PRICE = {
  [process.env.STRIPE_PRICE_BASIC]: "basic",
  [process.env.STRIPE_PRICE_PREMIUM]: "premium",
};

function tierFromSubscription(subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  return TIER_BY_PRICE[priceId] || null;
}

async function sendWelcomeEmail(toEmail) {
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Blue Chip Swing Trader <support@bluechipswingtrader.com>",
        to: toEmail,
        subject: "Welcome to Blue Chip Swing Trader",
        html: `<div style="font-family:Georgia,serif;background:#0a0e1a;color:#e2e8f0;padding:24px;">
          <h1 style="color:#f8fafc;">Welcome to Blue Chip Swing Trader</h1>
          <p>Your 15-day free trial has started. During the trial you have full access to every feature, including AI Bracket.</p>
          <p>Sign in any time at <a href="https://bluechipswingtrader.com" style="color:#3b82f6;">bluechipswingtrader.com</a> with the email address you just used -- we'll send you a one-time sign-in link, no password needed.</p>
          <p>Questions? Reply to this email or write to support@bluechipswingtrader.com.</p>
        </div>`,
      }),
    });
  } catch (e) {
    console.error("Resend welcome email failed (non-fatal)", e);
  }
}

// Upserts the subscribers row for a completed Checkout Session. Links by the
// supabase_user_id we stamped into subscription_data.metadata at checkout time; falls
// back to matching an existing row by email (covers the case where a subscribers row
// was somehow already present, e.g. from a prior canceled subscription).
async function upsertFromCheckoutSession(admin, session, subscription) {
  const userId = session.metadata?.supabase_user_id || null;
  const email = session.customer_details?.email || session.customer_email;
  const tier = tierFromSubscription(subscription) || session.metadata?.tier || null;
  const tosAcceptedAt = session.consent?.terms_of_service === "accepted" ? new Date().toISOString() : null;

  const row = {
    user_id: userId,
    email,
    stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id,
    stripe_subscription_id: subscription.id,
    tier,
    status: subscription.status,
    trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
    current_period_end: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  };
  if (tosAcceptedAt) row.tos_accepted_at = tosAcceptedAt;

  let existing = null;
  if (userId) {
    ({ data: existing } = await admin.from("subscribers").select("id").eq("user_id", userId).maybeSingle());
  }
  if (!existing && email) {
    ({ data: existing } = await admin.from("subscribers").select("id").eq("email", email).maybeSingle());
  }

  if (existing) {
    await admin.from("subscribers").update(row).eq("id", existing.id);
    return existing.id;
  }
  const { data: inserted } = await admin.from("subscribers").insert(row).select("id").single();
  return inserted?.id || null;
}

// Trial-abuse guard: a Stripe card fingerprint is stable for a given physical/virtual card
// across completely unrelated customers/emails, so it's the right key to detect someone
// re-using the same card under a new email address to collect another free trial. Returns
// the (possibly trial-ended) subscription -- unchanged if the fingerprint is new or absent.
async function endTrialIfCardAlreadyUsed(admin, stripe, subscription) {
  const fingerprint = subscription.default_payment_method?.card?.fingerprint || null;
  if (!fingerprint || subscription.status !== "trialing") return { subscription, fingerprint };

  const { data: seen } = await admin
    .from("used_card_fingerprints")
    .select("fingerprint")
    .eq("fingerprint", fingerprint)
    .maybeSingle();

  if (seen) {
    // Ends the trial right now, which triggers an immediate charge attempt on the
    // subscription's default payment method -- this stops the free ride but still lets a
    // legitimate repeat use of the same card (e.g. a second household subscription) through
    // as a normal paid signup rather than blocking it outright.
    const updated = await stripe.subscriptions.update(subscription.id, { trial_end: "now" });
    return { subscription: updated, fingerprint };
  }
  return { subscription, fingerprint };
}

export { tierFromSubscription, upsertFromCheckoutSession, endTrialIfCardAlreadyUsed };

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers.get("stripe-signature");
  const rawBody = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response(JSON.stringify({ error: `Signature verification failed: ${err.message}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const admin = getAdminClient();

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      let subscription = await stripe.subscriptions.retrieve(session.subscription, {
        expand: ["default_payment_method"],
      });

      const guarded = await endTrialIfCardAlreadyUsed(admin, stripe, subscription);
      subscription = guarded.subscription;

      const subscriberId = await upsertFromCheckoutSession(admin, session, subscription);

      if (guarded.fingerprint) {
        // ignoreDuplicates: a repeat card keeps its original first_subscriber_id/first_used_at
        // rather than being overwritten by this later signup.
        await admin
          .from("used_card_fingerprints")
          .upsert(
            { fingerprint: guarded.fingerprint, first_subscriber_id: subscriberId, first_used_at: new Date().toISOString() },
            { onConflict: "fingerprint", ignoreDuplicates: true }
          );
      }

      const email = session.customer_details?.email || session.customer_email;
      if (email) await sendWelcomeEmail(email);
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      const tier = tierFromSubscription(subscription);
      await admin
        .from("subscribers")
        .update({
          status: subscription.status,
          ...(tier ? { tier } : {}),
          trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
          current_period_end: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_subscription_id", subscription.id);
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      await admin
        .from("subscribers")
        .update({ status: "canceled", updated_at: new Date().toISOString() })
        .eq("stripe_subscription_id", subscription.id);
    }
  } catch (err) {
    // Log but still 200 -- once the signature is verified, an internal DB blip shouldn't
    // make Stripe retry-storm this endpoint.
    console.error("stripe-webhook handler error (event still acknowledged)", err);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
