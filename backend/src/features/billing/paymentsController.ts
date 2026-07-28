import { Request, Response } from "express";
import prisma from "../../lib/prisma.js";
import { getMembership } from "../../utils/plan.js";
import { activateSubscription, cancelSubscriptionFromProvider, markPastDue, priceForPlan, recordPayment, recordWebhookEvent } from "./subscriptionService.js";
import * as stripeProvider from "./providers/stripe.js";
import * as paypalProvider from "./providers/paypal.js";
import * as flutterwaveProvider from "./providers/flutterwave.js";
import type { BillingCycle, PlanKey } from "../../../generated/prisma/client.js";

type AuthedRequest = Request & { user?: { id: string; email: string; firstname?: string } };

const FRONTEND_URL = process.env.APP_URL || "http://localhost:5173";
const SUCCESS_URL = process.env.FRONTEND_CHECKOUT_SUCCESS_URL || `${FRONTEND_URL}/app/billing?status=success`;
const CANCEL_URL = process.env.FRONTEND_CHECKOUT_CANCEL_URL || `${FRONTEND_URL}/app/billing?status=cancelled`;

// Shared entry checks for every "start a checkout" endpoint: caller must be
// the workspace owner (billing management is an Owner-only action per the
// role spec) and the requested plan/cycle must be real.
const authorizeCheckout = async (req: AuthedRequest, res: Response): Promise<
    | { ok: false }
    | { ok: true; workspaceId: string; planKey: Exclude<PlanKey, "FREE">; billingCycle: BillingCycle; amountCents: number; currency: string; userId: string; email: string }
> => {
    const authUser = req.user;
    if (!authUser) {
        res.status(401).json({ message: "Authentication required" });
        return { ok: false };
    }

    const { workspaceId, planKey, billingCycle } = req.body as { workspaceId?: string; planKey?: string; billingCycle?: string };
    if (!workspaceId || !planKey || !billingCycle) {
        res.status(400).json({ message: "workspaceId, planKey, and billingCycle are required" });
        return { ok: false };
    }
    if (planKey !== "PREMIUM" && planKey !== "TEAM") {
        res.status(400).json({ message: "planKey must be PREMIUM or TEAM" });
        return { ok: false };
    }
    if (billingCycle !== "MONTHLY" && billingCycle !== "ANNUAL") {
        res.status(400).json({ message: "billingCycle must be MONTHLY or ANNUAL" });
        return { ok: false };
    }

    const membership = await getMembership(authUser.id, workspaceId);
    if (!membership || membership.role !== "OWNER") {
        res.status(403).json({ message: "Only the workspace owner can manage billing" });
        return { ok: false };
    }

    const plan = await prisma.plan.findUniqueOrThrow({ where: { key: planKey } });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: authUser.id } });

    return {
        ok: true,
        workspaceId,
        planKey,
        billingCycle,
        amountCents: priceForPlan(plan, billingCycle),
        currency: "USD",
        userId: authUser.id,
        email: user.email,
    };
};

// ---------------------------------------------------------------- Stripe --

export const createStripeCheckout = async (req: AuthedRequest, res: Response) => {
    const authz = await authorizeCheckout(req, res);
    if (!authz.ok) return;
    try {
        const url = await stripeProvider.createCheckoutSession({
            workspaceId: authz.workspaceId,
            userId: authz.userId,
            planKey: authz.planKey,
            billingCycle: authz.billingCycle,
            customerEmail: authz.email,
            successUrl: SUCCESS_URL,
            cancelUrl: CANCEL_URL,
        });
        return res.status(200).json({ url });
    } catch (error) {
        console.error(error);
        return res.status(502).json({ message: error instanceof Error ? error.message : "Stripe checkout failed" });
    }
};

// Metadata (workspaceId/userId/planKey/billingCycle) is set on the
// Subscription at checkout time (see stripe.ts's subscription_data.metadata)
// — Invoice objects don't reliably carry it themselves, so invoice-driven
// events re-fetch the Subscription to read it back.
const resolveSubscriptionMetadata = async (subscriptionId: string) => {
    if (!stripeProvider.stripe) return null;
    const subscription = await stripeProvider.stripe.subscriptions.retrieve(subscriptionId);
    const metadata = subscription.metadata;
    if (!metadata?.workspaceId || !metadata.userId || !metadata.planKey || !metadata.billingCycle) return null;
    return {
        workspaceId: metadata.workspaceId,
        userId: metadata.userId,
        planKey: metadata.planKey as Exclude<PlanKey, "FREE">,
        billingCycle: metadata.billingCycle as BillingCycle,
        customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id ?? null,
    };
};

export const stripeWebhook = async (req: Request, res: Response) => {
    try {
        const signature = req.headers["stripe-signature"];
        if (typeof signature !== "string") return res.status(400).json({ message: "Missing Stripe signature" });

        const event = stripeProvider.constructWebhookEvent(req.body as Buffer, signature);

        const isNewEvent = await recordWebhookEvent("STRIPE", event.id);
        if (!isNewEvent) return res.status(200).json({ received: true, duplicate: true });

        if (event.type === "checkout.session.completed") {
            // Establishes the workspace<->Stripe linkage immediately on
            // redirect back from Checkout. Payment recording is deferred to
            // invoice.payment_succeeded below (fired for this same charge)
            // so there's exactly one code path recording Stripe payments —
            // covering the first invoice and every renewal identically —
            // instead of double-counting the initial charge here too.
            const object = event.data.object as { metadata?: Record<string, string>; customer?: string; subscription?: string };
            const metadata = object.metadata;
            if (metadata?.workspaceId && metadata.userId && metadata.planKey && metadata.billingCycle) {
                await activateSubscription({
                    workspaceId: metadata.workspaceId,
                    userId: metadata.userId,
                    planKey: metadata.planKey as Exclude<PlanKey, "FREE">,
                    billingCycle: metadata.billingCycle as BillingCycle,
                    provider: "STRIPE",
                    providerCustomerId: typeof object.customer === "string" ? object.customer : null,
                    providerSubscriptionId: typeof object.subscription === "string" ? object.subscription : undefined,
                });
            }
        } else if (event.type === "invoice.payment_succeeded") {
            // Fires for every successful subscription invoice — the initial
            // one and every renewal alike — with authoritative amount and
            // billing-period bounds, so this is the single source of truth
            // for Stripe payment history and period extension.
            const invoice = event.data.object as {
                id: string;
                amount_paid: number;
                currency: string;
                period_start: number;
                period_end: number;
                parent?: { subscription_details?: { subscription?: string | { id: string } } | null } | null;
            };
            const subscriptionRef = invoice.parent?.subscription_details?.subscription;
            const subscriptionId = typeof subscriptionRef === "string" ? subscriptionRef : subscriptionRef?.id;
            if (subscriptionId) {
                const meta = await resolveSubscriptionMetadata(subscriptionId);
                if (meta) {
                    const subscription = await activateSubscription({
                        workspaceId: meta.workspaceId,
                        userId: meta.userId,
                        planKey: meta.planKey,
                        billingCycle: meta.billingCycle,
                        provider: "STRIPE",
                        providerCustomerId: meta.customerId,
                        providerSubscriptionId: subscriptionId,
                        currentPeriodStart: new Date(invoice.period_start * 1000),
                        currentPeriodEnd: new Date(invoice.period_end * 1000),
                    });
                    await recordPayment({
                        subscriptionId: subscription.id,
                        userId: meta.userId,
                        provider: "STRIPE",
                        providerPaymentId: invoice.id,
                        amountCents: invoice.amount_paid,
                        currency: (invoice.currency || "usd").toUpperCase(),
                        billingCycle: meta.billingCycle,
                        status: "SUCCEEDED",
                    });
                }
            }
        } else if (event.type === "invoice.payment_failed") {
            const invoice = event.data.object as {
                parent?: { subscription_details?: { subscription?: string | { id: string } } | null } | null;
            };
            const subscriptionRef = invoice.parent?.subscription_details?.subscription;
            const subscriptionId = typeof subscriptionRef === "string" ? subscriptionRef : subscriptionRef?.id;
            if (subscriptionId) await markPastDue(subscriptionId, "Stripe payment failed");
        } else if (event.type === "customer.subscription.deleted") {
            const object = event.data.object as { id: string };
            await cancelSubscriptionFromProvider(object.id);
        }

        return res.status(200).json({ received: true });
    } catch (error) {
        console.error("[stripe webhook]", error);
        return res.status(400).json({ message: "Webhook verification failed" });
    }
};

// ---------------------------------------------------------------- PayPal --

export const createPaypalOrder = async (req: AuthedRequest, res: Response) => {
    const authz = await authorizeCheckout(req, res);
    if (!authz.ok) return;
    try {
        const { orderId, approveUrl } = await paypalProvider.createOrder({
            workspaceId: authz.workspaceId,
            userId: authz.userId,
            planKey: authz.planKey,
            billingCycle: authz.billingCycle,
            amountCents: authz.amountCents,
            currency: authz.currency,
            returnUrl: SUCCESS_URL,
            cancelUrl: CANCEL_URL,
        });
        return res.status(200).json({ orderId, url: approveUrl });
    } catch (error) {
        console.error(error);
        return res.status(502).json({ message: error instanceof Error ? error.message : "PayPal order creation failed" });
    }
};

export const capturePaypalOrder = async (req: AuthedRequest, res: Response) => {
    try {
        const authUser = req.user;
        if (!authUser) return res.status(401).json({ message: "Authentication required" });

        const { orderId } = req.body as { orderId?: string };
        if (!orderId) return res.status(400).json({ message: "orderId is required" });

        const result = await paypalProvider.captureOrder(orderId);
        if (result.status !== "COMPLETED") {
            return res.status(402).json({ message: `PayPal payment not completed (status: ${result.status})` });
        }

        const subscription = await activateSubscription({
            workspaceId: result.workspaceId,
            userId: result.userId,
            planKey: result.planKey,
            billingCycle: result.billingCycle,
            provider: "PAYPAL",
        });
        await recordPayment({
            subscriptionId: subscription.id,
            userId: result.userId,
            provider: "PAYPAL",
            providerPaymentId: orderId,
            amountCents: result.amountCents,
            currency: result.currency,
            billingCycle: result.billingCycle,
            status: "SUCCEEDED",
        });

        return res.status(200).json({ subscription });
    } catch (error) {
        console.error(error);
        return res.status(502).json({ message: error instanceof Error ? error.message : "PayPal capture failed" });
    }
};

export const paypalWebhook = async (req: Request, res: Response) => {
    try {
        const verified = await paypalProvider.verifyWebhookSignature(req.headers as Record<string, string>, req.body);
        if (!verified) return res.status(400).json({ message: "Webhook signature verification failed" });

        const body = req.body as { id?: string; event_type?: string; resource?: { custom_id?: string; id?: string; amount?: { value?: string; currency_code?: string } } };
        if (!body.id) return res.status(200).json({ received: true });

        const isNewEvent = await recordWebhookEvent("PAYPAL", body.id);
        if (!isNewEvent) return res.status(200).json({ received: true, duplicate: true });

        // The capture endpoint above is what actually activates the
        // subscription on success (PayPal's redirect-then-capture flow) —
        // this webhook stays a no-op for completions, to avoid
        // double-activating. It does record failed/denied captures though,
        // since those never hit our capture endpoint and would otherwise
        // leave no trace in payment history at all.
        if (body.event_type === "PAYMENT.CAPTURE.DENIED" && body.resource?.custom_id) {
            try {
                const meta = JSON.parse(body.resource.custom_id) as { workspaceId?: string; userId?: string; planKey?: string; billingCycle?: string };
                if (meta.workspaceId && meta.userId && meta.planKey && meta.billingCycle) {
                    const subscription = await prisma.subscription.findUnique({ where: { workspaceId: meta.workspaceId } });
                    if (subscription && body.resource.id) {
                        await recordPayment({
                            subscriptionId: subscription.id,
                            userId: meta.userId,
                            provider: "PAYPAL",
                            providerPaymentId: body.resource.id,
                            amountCents: Math.round(parseFloat(body.resource.amount?.value || "0") * 100),
                            currency: body.resource.amount?.currency_code || "USD",
                            billingCycle: meta.billingCycle as BillingCycle,
                            status: "FAILED",
                        });
                    }
                }
            } catch {
                // Malformed custom_id — nothing to attribute the failure to.
            }
        }

        return res.status(200).json({ received: true });
    } catch (error) {
        console.error("[paypal webhook]", error);
        return res.status(400).json({ message: "Webhook processing failed" });
    }
};

// ----------------------------------------------------------- Flutterwave --

export const initiateFlutterwavePayment = async (req: AuthedRequest, res: Response) => {
    const authz = await authorizeCheckout(req, res);
    if (!authz.ok) return;
    try {
        const { txRef, paymentLink } = await flutterwaveProvider.initiatePayment({
            workspaceId: authz.workspaceId,
            userId: authz.userId,
            planKey: authz.planKey,
            billingCycle: authz.billingCycle,
            amountCents: authz.amountCents,
            currency: authz.currency,
            customerEmail: authz.email,
            redirectUrl: SUCCESS_URL,
        });
        return res.status(200).json({ txRef, url: paymentLink });
    } catch (error) {
        console.error(error);
        return res.status(502).json({ message: error instanceof Error ? error.message : "Flutterwave initiation failed" });
    }
};

export const verifyFlutterwavePayment = async (req: AuthedRequest, res: Response) => {
    try {
        const authUser = req.user;
        if (!authUser) return res.status(401).json({ message: "Authentication required" });

        const transactionId = (req.query.transactionId as string) || (req.body as { transactionId?: string })?.transactionId;
        if (!transactionId) return res.status(400).json({ message: "transactionId is required" });

        const result = await flutterwaveProvider.verifyTransaction(transactionId);
        if (result.status !== "successful") {
            return res.status(402).json({ message: `Flutterwave payment not successful (status: ${result.status})` });
        }

        const subscription = await activateSubscription({
            workspaceId: result.workspaceId,
            userId: result.userId,
            planKey: result.planKey,
            billingCycle: result.billingCycle,
            provider: "FLUTTERWAVE",
        });
        await recordPayment({
            subscriptionId: subscription.id,
            userId: result.userId,
            provider: "FLUTTERWAVE",
            providerPaymentId: result.transactionId,
            amountCents: result.amountCents,
            currency: result.currency,
            billingCycle: result.billingCycle,
            status: "SUCCEEDED",
        });

        return res.status(200).json({ subscription });
    } catch (error) {
        console.error(error);
        return res.status(502).json({ message: error instanceof Error ? error.message : "Flutterwave verification failed" });
    }
};

export const flutterwaveWebhook = async (req: Request, res: Response) => {
    try {
        const headerHash = req.headers["verif-hash"];
        if (!flutterwaveProvider.isValidWebhookSignature(typeof headerHash === "string" ? headerHash : undefined)) {
            return res.status(401).json({ message: "Invalid webhook signature" });
        }

        const body = req.body as { data?: { id?: number | string } };
        const transactionId = body.data?.id ? String(body.data.id) : undefined;
        if (!transactionId) return res.status(200).json({ received: true });

        const isNewEvent = await recordWebhookEvent("FLUTTERWAVE", transactionId);
        if (!isNewEvent) return res.status(200).json({ received: true, duplicate: true });

        // Re-verify against Flutterwave's API rather than trusting the
        // webhook body directly (see verifyTransaction's docstring).
        const result = await flutterwaveProvider.verifyTransaction(transactionId);
        if (result.status === "successful" && result.workspaceId) {
            const subscription = await activateSubscription({
                workspaceId: result.workspaceId,
                userId: result.userId,
                planKey: result.planKey,
                billingCycle: result.billingCycle,
                provider: "FLUTTERWAVE",
            });
            await recordPayment({
                subscriptionId: subscription.id,
                userId: result.userId,
                provider: "FLUTTERWAVE",
                providerPaymentId: result.transactionId,
                amountCents: result.amountCents,
                currency: result.currency,
                billingCycle: result.billingCycle,
                status: "SUCCEEDED",
            });
        } else if (result.workspaceId) {
            // Not successful (failed/cancelled) — still record it so payment
            // history shows the attempt rather than leaving no trace.
            const subscription = await prisma.subscription.findUnique({ where: { workspaceId: result.workspaceId } });
            if (subscription) {
                await recordPayment({
                    subscriptionId: subscription.id,
                    userId: result.userId,
                    provider: "FLUTTERWAVE",
                    providerPaymentId: result.transactionId,
                    amountCents: result.amountCents,
                    currency: result.currency,
                    billingCycle: result.billingCycle,
                    status: "FAILED",
                });
            }
        }

        return res.status(200).json({ received: true });
    } catch (error) {
        console.error("[flutterwave webhook]", error);
        return res.status(200).json({ received: true });
    }
};
