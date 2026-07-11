import Stripe from "stripe";
import { checkEntitlement, lookupSubscriber } from "../lib/entitlement.mjs";

const PRICE_IDS = {
  basic: process.env.STRIPE_PRICE_BASIC,
  premium: process.env.STRIPE_PRICE_PREMIUM,
};

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const ent = await checkEntitlement(req, { authOnly: true });
  if (!ent.ok) {
    return new Response(JSON.stringify({ error: ent.error }), {
      status: ent.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({}));
  const tier = body.tier;
  if (tier !== "basic" && tier !== "premium") {
    return new Response(JSON.stringify({ error: "tier must be 'basic' or 'premium'" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const existing = await lookupSubscriber(ent.user);
  const siteUrl = process.env.URL || "https://bluechipswingtrader.com";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      ...(existing?.stripe_customer_id
        ? { customer: existing.stripe_customer_id }
        : { customer_email: ent.user.email }),
      line_items: [{ price: PRICE_IDS[tier], quantity: 1 }],
      subscription_data: {
        trial_period_days: 15,
        metadata: { supabase_user_id: ent.user.id, tier },
      },
      consent_collection: { terms_of_service: "required" },
      allow_promotion_codes: true,
      client_reference_id: ent.user.id,
      metadata: { supabase_user_id: ent.user.id, tier },
      success_url: `${siteUrl}/?checkout=success`,
      cancel_url: `${siteUrl}/?checkout=cancelled`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Checkout creation failed", detail: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
