import prisma from "../../lib/prisma.js";
import { createActivityLog } from "../../utils/activity.js";
import type { BillingCycle, PaymentProvider, PaymentStatus, PlanKey } from "../../../generated/prisma/client.js";

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

export const periodEndFor = (billingCycle: BillingCycle, from: Date = new Date()): Date =>
    new Date(from.getTime() + (billingCycle === "ANNUAL" ? MS_PER_YEAR : MS_PER_MONTH));

export const priceForPlan = (plan: { priceMonthlyCents: number; priceAnnualCents: number }, billingCycle: BillingCycle) =>
    billingCycle === "ANNUAL" ? plan.priceAnnualCents : plan.priceMonthlyCents;

// Activates (or renews) a workspace's subscription once a provider confirms
// payment. Idempotent per (workspaceId, periodStart) is not enforced here —
// callers should only invoke this once per confirmed payment event; the
// Payment row's unique providerPaymentId, plus the WebhookEvent ledger
// (see recordWebhookEvent) for webhook-triggered callers, are what actually
// protect against duplicate webhook delivery.
export const activateSubscription = async (params: {
    workspaceId: string;
    userId: string;
    planKey: Exclude<PlanKey, "FREE">;
    billingCycle: BillingCycle;
    provider: PaymentProvider;
    providerCustomerId?: string | null;
    providerSubscriptionId?: string | null;
    // Callers with authoritative period data from the provider (e.g. a
    // Stripe invoice's period_start/period_end) should pass it explicitly
    // rather than relying on the approximate 30/365-day fallback below,
    // which exists for providers that don't hand back real period bounds
    // (PayPal/Flutterwave, both single-charge-per-cycle here).
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date;
}) => {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { key: params.planKey } });
    const now = new Date();
    const periodStart = params.currentPeriodStart ?? now;
    const periodEnd = params.currentPeriodEnd ?? periodEndFor(params.billingCycle, periodStart);

    const subscription = await prisma.subscription.upsert({
        where: { workspaceId: params.workspaceId },
        create: {
            workspaceId: params.workspaceId,
            planId: plan.id,
            status: "ACTIVE",
            billingCycle: params.billingCycle,
            provider: params.provider,
            providerCustomerId: params.providerCustomerId,
            providerSubscriptionId: params.providerSubscriptionId,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
        },
        update: {
            planId: plan.id,
            status: "ACTIVE",
            billingCycle: params.billingCycle,
            provider: params.provider,
            providerCustomerId: params.providerCustomerId,
            providerSubscriptionId: params.providerSubscriptionId,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            cancelAtPeriodEnd: false,
            canceledAt: null,
        },
        include: { plan: true },
    });

    await createActivityLog({
        userId: params.userId,
        action: `Subscription activated on the ${plan.name} plan (${params.billingCycle.toLowerCase()}) via ${params.provider}`,
        workspaceId: params.workspaceId,
    });

    return subscription;
};

// A renewal payment failed (e.g. Stripe's invoice.payment_failed) — reflect
// that in the subscription status so plan gating can react (grace period is
// intentionally left to the provider's own dunning/retry schedule; we just
// mirror whatever they tell us). Looked up by provider subscription id since
// webhook events don't carry our internal workspaceId/userId directly.
export const markPastDue = async (providerSubscriptionId: string, reason: string) => {
    const subscription = await prisma.subscription.findUnique({ where: { providerSubscriptionId } });
    if (!subscription) return null;

    const updated = await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "PAST_DUE" },
        include: { plan: true },
    });

    const owner = await prisma.workspaceMember.findFirst({ where: { workspaceId: subscription.workspaceId, role: "OWNER" } });
    if (owner) {
        await createActivityLog({
            userId: owner.userId,
            action: `Payment failed for the ${updated.plan.name} subscription (${reason}) — marked past due`,
            workspaceId: subscription.workspaceId,
        });
    }

    return updated;
};

// Provider-initiated cancellation (e.g. Stripe's customer.subscription.deleted
// — cancelled directly in the Stripe dashboard/API rather than through our
// own /cancel endpoint). Distinct from cancelSubscription below, which is the
// app-driven "cancel at period end" flow; this reflects an already-ended
// subscription immediately.
export const cancelSubscriptionFromProvider = async (providerSubscriptionId: string) => {
    const subscription = await prisma.subscription.findUnique({ where: { providerSubscriptionId }, include: { plan: true } });
    if (!subscription) return null;

    const updated = await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "CANCELED", cancelAtPeriodEnd: false, canceledAt: subscription.canceledAt ?? new Date() },
        include: { plan: true },
    });

    const owner = await prisma.workspaceMember.findFirst({ where: { workspaceId: subscription.workspaceId, role: "OWNER" } });
    if (owner) {
        await createActivityLog({
            userId: owner.userId,
            action: `The ${updated.plan.name} subscription was cancelled by the payment provider`,
            workspaceId: subscription.workspaceId,
        });
    }

    return updated;
};

// Event-level idempotency for webhooks: returns true the first time a given
// (provider, externalId) pair is seen, false on any redelivery — checked
// (and written) before any side-effecting work runs, so retried webhooks
// short-circuit immediately rather than relying solely on downstream unique
// constraints like Payment.providerPaymentId to absorb duplicates.
export const recordWebhookEvent = async (provider: PaymentProvider, externalId: string): Promise<boolean> => {
    try {
        await prisma.webhookEvent.create({ data: { provider, externalId } });
        return true;
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") return false;
        throw error;
    }
};

// Records a payment, tolerating webhook redelivery: providerPaymentId is
// unique, so a retried webhook just no-ops instead of double-billing the
// activity log / creating a duplicate row.
export const recordPayment = async (params: {
    subscriptionId: string;
    userId: string;
    provider: PaymentProvider;
    providerPaymentId: string;
    amountCents: number;
    currency: string;
    billingCycle: BillingCycle;
    status: PaymentStatus;
}) => {
    const existing = await prisma.payment.findUnique({ where: { providerPaymentId: params.providerPaymentId } });
    if (existing) return existing;

    return prisma.payment.create({ data: params });
};

export const cancelSubscription = async (workspaceId: string, userId: string) => {
    const subscription = await prisma.subscription.findUnique({ where: { workspaceId } });
    if (!subscription) throw new Error("Subscription not found");

    const updated = await prisma.subscription.update({
        where: { workspaceId },
        data: { cancelAtPeriodEnd: true, canceledAt: new Date() },
        include: { plan: true },
    });

    await createActivityLog({
        userId,
        action: `Cancelled the ${updated.plan.name} subscription (access continues until the current period ends)`,
        workspaceId,
    });

    return updated;
};
