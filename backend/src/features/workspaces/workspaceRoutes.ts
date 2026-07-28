import express from "express";
import { createWorkspace, deleteWorkspace, listMembers, listWorkspaces, removeMember, updateMemberRole } from "./workspaceController.js";
import { authenticate } from "../../middleware/authMiddleware.js";

const router = express.Router();

router.get("/", authenticate, listWorkspaces);
router.post("/", authenticate, createWorkspace);
router.delete("/:workspaceId", authenticate, deleteWorkspace);
router.get("/:workspaceId/members", authenticate, listMembers);
router.patch("/:workspaceId/members/:memberId", authenticate, updateMemberRole);
router.delete("/:workspaceId/members/:memberId", authenticate, removeMember);

export default router;
