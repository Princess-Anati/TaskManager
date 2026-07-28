import { Request, Response } from "express";
import prisma from "../../lib/prisma.js";
import { createActivityLog } from "../../utils/activity.js";
import { assertWithinWorkspaceLimit } from "../../utils/plan.js";
import { deleteObject } from "../files/storage.js";
import * as stripeProvider from "../billing/providers/stripe.js";

export const listWorkspaces = async (req: Request, res: Response) => {
    try {
        const authUser = (req as Request & { user?: { id: string; email: string } }).user;
        if (!authUser) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const workspaces = await prisma.workspace.findMany({
            where: { members: { some: { userId: authUser.id } } },
            include: { members: true, subscription: { include: { plan: true } } },
        });

        return res.status(200).json({ workspaces });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

export const createWorkspace = async (req: Request, res: Response) => {
    try {
        const authUser = (req as Request & { user?: { id: string; email: string } }).user;
        if (!authUser) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const { name, description, type } = req.body;
        if (!name) {
            return res.status(400).json({ message: "Workspace name is required" });
        }
        const workspaceType = type === "TEAM" ? "TEAM" : "PERSONAL";

        // Team workspaces aren't limited in count — what's actually gated is
        // real collaboration (more than one member), which is enforced by the
        // workspace's own plan (see assertWithinMemberLimit) once someone
        // tries to invite a second person. Only personal-workspace count is
        // capped per the owner's plan.
        if (workspaceType === "PERSONAL") {
            const limitError = await assertWithinWorkspaceLimit(authUser.id);
            if (limitError) return res.status(403).json(limitError);
        }

        const freePlan = await prisma.plan.findUniqueOrThrow({ where: { key: "FREE" } });

        const workspace = await prisma.workspace.create({
            data: {
                name,
                description,
                type: workspaceType,
                members: {
                    create: [{ userId: authUser.id, role: "OWNER" }],
                },
                subscription: {
                    create: { planId: freePlan.id, status: "ACTIVE", billingCycle: "MONTHLY" },
                },
            },
            include: { members: true, subscription: { include: { plan: true } } },
        });

        await createActivityLog({ userId: authUser.id, action: `Created workspace ${workspace.name}`, workspaceId: workspace.id });

        return res.status(201).json({ workspace });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

export const listMembers = async (req: Request, res: Response) => {
    try {
        const authUser = (req as Request & { user?: { id: string; email: string } }).user;
        if (!authUser) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const workspaceIdParam = req.params.workspaceId;
        const workspaceId = Array.isArray(workspaceIdParam) ? workspaceIdParam[0] : workspaceIdParam;
        if (!workspaceId) {
            return res.status(400).json({ message: "Workspace id is required" });
        }

        const membership = await prisma.workspaceMember.findUnique({
            where: { userId_workspaceId: { userId: authUser.id, workspaceId } },
        });
        if (!membership) {
            return res.status(403).json({ message: "You are not a member of this workspace" });
        }

        const members = await prisma.workspaceMember.findMany({
            where: { workspaceId },
            include: {
                user: {
                    select: { id: true, firstname: true, lastName: true, email: true, avatarUrl: true },
                },
            },
        });

        return res.status(200).json({ members });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

const ASSIGNABLE_ROLES = ["ADMIN", "MANAGER", "MEMBER", "GUEST"];

export const updateMemberRole = async (req: Request, res: Response) => {
    try {
        const authUser = (req as Request & { user?: { id: string; email: string } }).user;
        if (!authUser) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const workspaceId = String(req.params.workspaceId);
        const memberId = String(req.params.memberId);
        const { role } = req.body;
        if (!ASSIGNABLE_ROLES.includes(role)) {
            return res.status(400).json({ message: `Role must be one of ${ASSIGNABLE_ROLES.join(", ")}` });
        }

        const membership = await prisma.workspaceMember.findUnique({
            where: { userId_workspaceId: { userId: authUser.id, workspaceId } },
        });
        if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
            return res.status(403).json({ message: "Only workspace owners and admins can change member roles" });
        }

        const target = await prisma.workspaceMember.findUnique({ where: { id: memberId } });
        if (!target || target.workspaceId !== workspaceId) {
            return res.status(404).json({ message: "Member not found" });
        }
        if (target.role === "OWNER") {
            return res.status(400).json({ message: "The workspace owner's role cannot be changed" });
        }

        const updated = await prisma.workspaceMember.update({
            where: { id: memberId },
            data: { role },
            include: { user: { select: { id: true, firstname: true, lastName: true, email: true, avatarUrl: true } } },
        });

        await createActivityLog({
            userId: authUser.id,
            action: `Changed ${updated.user.firstname} ${updated.user.lastName}'s role to ${role}`,
            workspaceId,
        });

        return res.status(200).json({ member: updated });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

export const removeMember = async (req: Request, res: Response) => {
    try {
        const authUser = (req as Request & { user?: { id: string; email: string } }).user;
        if (!authUser) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const workspaceId = String(req.params.workspaceId);
        const memberId = String(req.params.memberId);

        const membership = await prisma.workspaceMember.findUnique({
            where: { userId_workspaceId: { userId: authUser.id, workspaceId } },
        });
        if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
            return res.status(403).json({ message: "Only workspace owners and admins can remove members" });
        }

        const target = await prisma.workspaceMember.findUnique({
            where: { id: memberId },
            include: { user: { select: { firstname: true, lastName: true } } },
        });
        if (!target || target.workspaceId !== workspaceId) {
            return res.status(404).json({ message: "Member not found" });
        }
        if (target.role === "OWNER") {
            return res.status(400).json({ message: "The workspace owner cannot be removed" });
        }

        await prisma.workspaceMember.delete({ where: { id: memberId } });

        await createActivityLog({
            userId: authUser.id,
            action: `Removed ${target.user.firstname} ${target.user.lastName} from the workspace`,
            workspaceId,
        });

        return res.status(200).json({ message: "Member removed" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// Irreversible — every Task/Comment/File/Notification/ActivityLog/
// Subscription/Payment row scoped to this workspace cascades away with it
// (see the onDelete: Cascade relations on Workspace in schema.prisma), and
// every other member loses access immediately. No activity-log entry is
// written for the deletion itself: ActivityLog.workspaceId also cascades,
// so a record scoped to this workspace would vanish along with it and
// nothing in the UI surfaces workspace-less log entries.
export const deleteWorkspace = async (req: Request, res: Response) => {
    try {
        const authUser = (req as Request & { user?: { id: string; email: string } }).user;
        if (!authUser) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const workspaceId = String(req.params.workspaceId);

        const membership = await prisma.workspaceMember.findUnique({
            where: { userId_workspaceId: { userId: authUser.id, workspaceId } },
        });
        if (!membership || membership.role !== "OWNER") {
            return res.status(403).json({ message: "Only the workspace owner can delete this workspace" });
        }

        const workspace = await prisma.workspace.findUnique({
            where: { id: workspaceId },
            include: { subscription: true, files: { select: { storedName: true } } },
        });
        if (!workspace) {
            return res.status(404).json({ message: "Workspace not found" });
        }

        // Best-effort: stop the recurring charge at the provider before the
        // Subscription row disappears — otherwise Stripe keeps billing a
        // subscription nothing here still references. PayPal/Flutterwave
        // have no equivalent (see providers/paypal.ts and flutterwave.ts —
        // both charge once per cycle rather than a true recurring
        // subscription object), so there's nothing to cancel on their side.
        if (workspace.subscription?.provider === "STRIPE" && workspace.subscription.providerSubscriptionId && stripeProvider.stripe) {
            try {
                await stripeProvider.stripe.subscriptions.cancel(workspace.subscription.providerSubscriptionId);
            } catch (error) {
                console.error(`[workspace delete] Failed to cancel Stripe subscription ${workspace.subscription.providerSubscriptionId}:`, error);
            }
        }

        // Best-effort: clean up the actual stored blobs (R2 or local disk) —
        // deleting the File rows via cascade below doesn't touch storage.
        await Promise.all(
            workspace.files.map((file) =>
                deleteObject(`${workspaceId}/${file.storedName}`).catch((error) =>
                    console.error(`[workspace delete] Failed to delete stored file ${file.storedName}:`, error),
                ),
            ),
        );

        await prisma.workspace.delete({ where: { id: workspaceId } });

        return res.status(200).json({ message: "Workspace deleted" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};
