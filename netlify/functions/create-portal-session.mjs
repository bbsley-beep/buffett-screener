import Stripe from "stripe";
import { checkEntitlement, lookupSubscriber } from "../lib/entitlement.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // authOnly: even a canceled subscriber should be able to reach the portal to see
  // past invoices or resubscribe, not just currently-active ones.
  const ent = await checkEntitlement(req, { authOnly: true });
  if (!ent.ok) {
    return new Response(JSON.stringify({ error: ent.error }), {
      status: ent.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sub = await lookupSubscriber(ent.user);
  if (!sub?.stripe_customer_id) {
    return new Response(JSON.stringify({ error: "No billing account found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const siteUrl = process.env.URL || "https://bluechipswingtrader.com";

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${siteUrl}/`,
    });
    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Portal session creation failed", detail: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
