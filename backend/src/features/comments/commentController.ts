import { Request, Response } from "express";
import prisma from "../../lib/prisma.js";
import { createActivityLog } from "../../utils/activity.js";
import { getMembership } from "../../utils/plan.js";
import { sendPushToUser } from "../../utils/push.js";

type AuthedRequest = Request & { user?: { id: string; email: string } };

const COMMENT_INCLUDE = {
    user: { select: { id: true, firstname: true, lastName: true, avatarUrl: true } },
} as const;

// In-app row plus a real-time Web Push alert, same pattern as
// taskController's notifyAssignee — mentions and comments on your tasks
// should reach you immediately, not just on the next poll.
const notifyIfEnabled = async (userId: string, data: { workspaceId: string; taskId: string; message: string }) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { taskNotificationsEnabled: true } });
    if (!user?.taskNotificationsEnabled) return;
    const notification = await prisma.notification.create({ data: { userId, type: "TASK_COMMENTED", ...data } });

    const prefs = await prisma.notificationPreference.findUnique({ where: { userId } });
    if (!prefs || prefs.pushEnabled) {
        await sendPushToUser(userId, {
            title: "New comment",
            body: data.message,
            tag: `notif-${notification.id}`,
            url: `/app/tasks?taskId=${data.taskId}`,
            taskId: data.taskId,
            notificationId: notification.id,
            sound: prefs?.soundEnabled ?? true,
            vibrate: prefs?.vibrationEnabled ?? true,
        });
    }
};

export const listComments = async (req: AuthedRequest, res: Response) => {
    try {
        const authUser = req.user;
        if (!authUser) return res.status(401).json({ message: "Authentication required" });

        const taskId = String(req.params.taskId);
        const task = await prisma.task.findUnique({ where: { id: taskId } });
        if (!task) return res.status(404).json({ message: "Task not found" });

        const membership = await getMembership(authUser.id, task.workspaceId);
        if (!membership) return res.status(403).json({ message: "You are not a member of this workspace" });

        const comments = await prisma.comment.findMany({
            where: { taskId },
            include: COMMENT_INCLUDE,
            orderBy: { createdAt: "asc" },
        });

        return res.status(200).json({ comments });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

export const createComment = async (req: AuthedRequest, res: Response) => {
    try {
        const authUser = req.user;
        if (!authUser) return res.status(401).json({ message: "Authentication required" });

        const taskId = String(req.params.taskId);
        const { body, mentions } = req.body as { body?: string; mentions?: string[] };
        if (!body?.trim()) return res.status(400).json({ message: "Comment body is required" });

        const task = await prisma.task.findUnique({ where: { id: taskId } });
        if (!task) return res.status(404).json({ message: "Task not found" });

        const membership = await getMembership(authUser.id, task.workspaceId);
        if (!membership) return res.status(403).json({ message: "You are not a member of this workspace" });

        // Only accept mentions that actually resolve to members of this
        // workspace — otherwise a client could spam notifications to
        // arbitrary user ids.
        const workspaceMembers = await prisma.workspaceMember.findMany({
            where: { workspaceId: task.workspaceId },
            select: { userId: true },
        });
        const memberIds = new Set(workspaceMembers.map((m) => m.userId));
        const validMentions = (mentions || []).filter((id) => memberIds.has(id) && id !== authUser.id);

        const comment = await prisma.comment.create({
            data: { taskId, userId: authUser.id, body: body.trim(), mentions: validMentions },
            include: COMMENT_INCLUDE,
        });

        await createActivityLog({
            userId: authUser.id,
            action: `Commented on task ${task.title}`,
            workspaceId: task.workspaceId,
            taskId: task.id,
        });

        const notifiedAlready = new Set<string>();
        for (const mentionedUserId of validMentions) {
            await notifyIfEnabled(mentionedUserId, {
                workspaceId: task.workspaceId,
                taskId: task.id,
                message: `${comment.user.firstname} mentioned you in a comment on "${task.title}"`,
            });
            notifiedAlready.add(mentionedUserId);
        }
        if (task.assignedToId && task.assignedToId !== authUser.id && !notifiedAlready.has(task.assignedToId)) {
            await notifyIfEnabled(task.assignedToId, {
                workspaceId: task.workspaceId,
                taskId: task.id,
                message: `${comment.user.firstname} commented on "${task.title}"`,
            });
        }

        return res.status(201).json({ comment });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

export const deleteComment = async (req: AuthedRequest, res: Response) => {
    try {
        const authUser = req.user;
        if (!authUser) return res.status(401).json({ message: "Authentication required" });

        const id = String(req.params.id);
        const comment = await prisma.comment.findUnique({ where: { id } });
        if (!comment) return res.status(404).json({ message: "Comment not found" });

        const membership = await getMembership(authUser.id, (await prisma.task.findUniqueOrThrow({ where: { id: comment.taskId } })).workspaceId);
        const canModerate = membership && ["OWNER", "ADMIN", "MANAGER"].includes(membership.role);
        if (comment.userId !== authUser.id && !canModerate) {
            return res.status(403).json({ message: "You can only delete your own comments" });
        }

        await prisma.comment.delete({ where: { id } });
        return res.status(200).json({ message: "Comment deleted" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};
