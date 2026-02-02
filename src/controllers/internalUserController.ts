import { Request, Response } from "express";
import { startOfMonth, endOfMonth, subMonths } from "date-fns";
import { internalUserSchema } from "../utils/zodSchemas";
import { uploadToCloudinary } from "../services/uploadService";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { sendEmail } from "../services/emailSevices";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { AuthRequest } from "../middlewares/authMiddleware";

import prisma from "../lib/prisma";
const JWT_SECRET = process.env.JWT_SECRET!;

export const createInternalUser = async (req: Request, res: Response) => {
  const body = internalUserSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      message: "Invalid internal user input",
      errors: body.error.flatten(),
    });
  }

  const {
    name,
    email,
    phone,
    ministry,
    department,
    approvingPosition,
    function: workflowFunction,
    role,
    requiresSignature,
    signatureUrl,
    stateId,
  } = body.data;

  // Generate verification token (expires in 24 hours)
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  try {
    const existing = await prisma.internalUser.findUnique({ where: { email } });
    if (existing)
      return res.status(400).json({ message: "Internal user already exists" });
    const state = await prisma.state.findUnique({
      where: { id: stateId },
      include: {
        approvers: true,
        governor: true,
      },
    });
    if (!state) {
      return res.status(401).json({
        message: "State not found",
      });
    }
    console.log(role);

    if (role === "GOVERNOR") {
      console.log("Governor", role);
      if (!approvingPosition || isNaN(Number(approvingPosition))) {
        return res
          .status(400)
          .json({ message: "Governor must have a numeric approving position" });
      }

      if (state.governorId) {
        return res.status(400).json({
          message: "A Governor has already been registered for this State",
        });
      }
    }

    if (role === "APPROVER" && approvingPosition) {
      return res
        .status(400)
        .json({ message: "Approver should not have an approving position" });
    }

    let currentApprovers = 0;

    if (role === "APPROVER") {
      if (!state.governor) {
        return res.status(400).json({
          message:
            "You cannot register approvers before a Governor has been assigned to this State",
        });
      }

      const governorLimit = state.governor.approvingPosition || 0;

      currentApprovers = await prisma.internalUser.count({
        where: {
          stateId,
          role: "APPROVER",
        },
      });

      if (currentApprovers >= governorLimit) {
        return res.status(400).json({
          message: `Maximum approvers reached for this state — Governor's limit is ${governorLimit}.`,
        });
      }
    }

    const user = await prisma.internalUser.create({
      data: {
        name,
        email,
        phone,
        ministry,
        department,
        approvingPosition:
          role === "GOVERNOR" ? Number(approvingPosition) : null,
        position: role === "APPROVER" ? currentApprovers + 1 : null,
        function: workflowFunction,
        role: role === "APPROVER" ? "APPROVER" : "GOVERNOR",
        requiresSignature: requiresSignature ?? false,
        signatureUrl,
        stateId: stateId as string,
        isVerified: false,
        emailToken: token,
        tokenExpiresAt: expires,
      },
    });

    if (role === "GOVERNOR")
      await prisma.state.update({
        where: { id: stateId },
        data: {
          governorId: user.id,
        },
      });
    const verifyLink = `http://localhost:5173/verify?token=${token}`;
    await sendEmail(
      email,
      "Verify Your Internal Account",
      `<p>Hello ${name},</p>
       <p>You have been registered as a ${role} on the GeoTech platform.</p>
       <p>Verify your email by clicking below (expires in 24 hours):</p>
       <a href="${verifyLink}">${verifyLink}</a>`,
    );

    res.status(201).json({ message: "Internal user created", user });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to create internal user", error: err });
  }
};
export const uploadSignature = async (req: any, res: Response) => {
  const userId = req.user.id; // from auth middleware
  const role = req.user.role;

  if (role !== "GOVERNOR") {
    return res
      .status(403)
      .json({ message: "Only governors can upload signatures" });
  }

  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded" });
  }

  try {
    const uploaded = await uploadToCloudinary(req.file.path);
    fs.unlinkSync(path.resolve(req.file.path));

    await prisma.internalUser.update({
      where: { id: userId },
      data: { signatureUrl: uploaded.secure_url, requiresSignature: true },
    });

    res.json({
      message: "Signature uploaded successfully",
      signatureUrl: uploaded.secure_url,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Signature upload failed", error: err });
  }
};
export const updateSignature = async (req: any, res: Response) => {
  const userId = req.user.id;
  const role = req.user.role;

  if (role !== "GOVERNOR") {
    return res
      .status(403)
      .json({ message: "Only governors can update signature" });
  }

  if (!req.file) {
    return res.status(400).json({ message: "No signature image uploaded" });
  }

  try {
    const uploaded = await uploadToCloudinary(req.file.path);
    fs.unlinkSync(path.resolve(req.file.path));

    const updated = await prisma.internalUser.update({
      where: { id: userId },
      data: {
        signatureUrl: uploaded.secure_url,
        requiresSignature: true,
      },
      select: { id: true, email: true, signatureUrl: true },
    });

    res.json({
      message: "Signature updated successfully",
      signatureUrl: updated.signatureUrl,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update signature", error: err });
  }
};
export const verifyInternalEmail = async (req: Request, res: Response) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({
      message: "Invalid or expired verification token",
    });
  }

  try {
    const allUsers = await prisma.internalUser.findMany({
      select: { id: true, email: true, emailToken: true, tokenExpiresAt: true },
    });

    console.log("🟡 Users in DB:", allUsers);
    // 🟢 FIND USER BY TOKEN ONLY
    const user = await prisma.internalUser.findFirst({
      where: { emailToken: token as string },
    });

    if (!user) {
      return res.status(400).json({
        message: "Token not found",
      });
    }

    // 🟢 CHECK EXPIRY MANUALLY
    if (!user.tokenExpiresAt || user.tokenExpiresAt < new Date()) {
      return res.status(400).json({
        message: "Verification token has expired",
      });
    }

    // 🟢 GENERATE PASSWORD SETUP TOKEN
    const passwordToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 mins

    await prisma.internalUser.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        emailToken: null, // 🧹 remove old token
        passwordToken,
        tokenExpiresAt: expires, // set new expiry
      },
    });

    return res.json({
      message: "Email verified. Proceed to set your password.",
      passwordToken,
    });
  } catch (err) {
    console.error("❌ verifyInternalEmail Error:", err);
    return res.status(500).json({
      message: "Verification failed",
      error: err,
    });
  }
};

export const setInternalUserPassword = async (req: Request, res: Response) => {
  const { token, password } = req.body;

  try {
    const user = await prisma.internalUser.findFirst({
      where: {
        passwordToken: token,
      },
    });

    if (!user)
      return res
        .status(400)
        .json({ message: "Invalid or expired password token" });

    if (!user.tokenExpiresAt || user.tokenExpiresAt < new Date()) {
      return res.status(400).json({
        message: "Verification token has expired",
      });
    }

    const hash = await bcrypt.hash(password, 10);

    await prisma.internalUser.update({
      where: { id: user.id },
      data: {
        password: hash,
        passwordToken: null,
        tokenExpiresAt: null,
      },
    });

    res.json({ message: "Password set successfully. You can now log in." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to set password", error: err });
  }
};
export const resendInternalVerification = async (
  req: Request,
  res: Response,
) => {
  const { email } = req.body;

  try {
    const user = await prisma.internalUser.findUnique({ where: { email } });

    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isVerified)
      return res.status(400).json({ message: "User already verified" });

    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.internalUser.update({
      where: { id: user.id },
      data: { emailToken: token, tokenExpiresAt: expires },
    });

    const verifyLink = `https://localhost:5173/resend-verify?token=${token}`;
    await sendEmail(
      email,
      "Resend Verification - GeoTech",
      `<p>Hello ${user.name},</p>
       <p>Here’s a new verification link for your internal account (expires in 24 hours):</p>
       <a href="${verifyLink}">${verifyLink}</a>`,
    );

    res.json({ message: "Verification email resent successfully" });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ message: "Failed to resend verification", error: err });
  }
};
export const loginInternalUser = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // Check if user exists
    const user = await prisma.internalUser.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ message: "User not found" });

    // Check if user has verified email
    if (!user.isVerified) {
      return res.status(403).json({
        message:
          "Email not verified. Please check your email to verify your account.",
      });
    }

    // Check if password has been set
    if (!user.password) {
      return res.status(403).json({
        message:
          "You have not set your password yet. Please verify your email and set a password first.",
      });
    }

    // Compare passwords
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ message: "Invalid credentials" });

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    res.json({
      message: "Login successful",
      user: {
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error" });
  }
};
export const getInternalUserSession = async (req: any, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const user = await prisma.internalUser.findUnique({
      where: { id: userId },
    });
    res.json({ user });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};
export const refreshInternalToken = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const internalUser = await prisma.internalUser.findUnique({
      where: { id: userId },
    });
    if (!internalUser)
      return res.status(404).json({ message: "internalUser not found" });
    if (internalUser.role !== "APPROVER" || "GOVERNOR")
      return res
        .status(403)
        .json({ message: "Not authorized as internalUser" });

    const newToken = jwt.sign(
      {
        id: internalUser.id,
        email: internalUser.email,
        role: internalUser.role,
        type: "internalUser",
      },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" },
    );

    res.cookie("token", newToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    res.json({
      message: "Token refreshed successfully",
      user: {
        id: internalUser.id,
        email: internalUser.email,
        name: internalUser.name,
        role: internalUser.role,
      },
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const logoutInternalUser = async (req: AuthRequest, res: Response) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
  });
  res.json({ message: "Logged out successfully" });
};

export const getDashboardStatsForReviwer = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = req.user.id;

  const reviewer = await prisma.internalUser.findUnique({
    where: { id: userId },
  });

  if (!reviewer) {
    return res.status(403).json({ message: "Not an internal user" });
  }

  const stateId = reviewer.stateId;

  if (!stateId) {
    return res.status(403).json({ message: "Reviewer has no assigned state" });
  }

  const total = await prisma.cofOApplication.count({
    where: {
      land: {
        stateId: stateId, // 👈 join filter
      },
    },
  });

  const pending = await prisma.inboxMessage.count({
    where: { status: "PENDING", receiverId: userId },
  });

  const completed = await prisma.inboxMessage.count({
    where: { status: "COMPLETED", receiverId: userId },
  });

  const needsCorrection = await prisma.cofOApplication.count({
    where: { status: "NEEDS_CORRECTION", currentReviewerId: userId },
  });

  const RESUBMITTED = await prisma.cofOApplication.count({
    where: { status: "RESUBMITTED", currentReviewerId: userId },
  });

  const rejected = await prisma.inboxMessage.count({
    where: { status: "REJECTED", receiverId: userId },
  });

  res.json({
    total,
    pending,
    needsCorrection,
    completed,
    RESUBMITTED,
    rejected,
  });
};

export const getDashboardStatsForGovernor = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = req.user.id;
  const governor = await prisma.internalUser.findUnique({
    where: { id: userId },
  });
  if (!governor) {
    return res.status(403).json({ message: "Not an internal user" });
  }
  const stateId = governor.stateId;

  if (!stateId) {
    return res.status(403).json({ message: "Governor has no assigned state" });
  }
  const total = await prisma.cofOApplication.count({
    where: {
      land: {
        stateId: stateId, // 👈 join filter
      },
    },
  });
  const pending = await prisma.cofOApplication.count({
    where: {
      status: "IN_REVIEW",
      land: {
        stateId: governor.stateId as string, // 👈 join fixlter
      },
    },
  });
  const approved = await prisma.cofOApplication.count({
    where: {
      status: "APPROVED",
      land: {
        stateId: governor.stateId as string, // 👈 join fixlter
      },
    },
  });
  const rejected = await prisma.cofOApplication.count({
    where: {
      status: "REJECTED_FINAL",
      land: {
        stateId: governor.stateId as string, // 👈 join fixlter
      },
    },
  });

  res.json({ total, pending, approved, rejected });
};

export const getCofOMonthlyTrends = async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.internalUser.findUnique({
      where: { id: req.user.id },
      select: { stateId: true, id: true },
    });

    if (!user?.stateId)
      return res.status(403).json({ message: "No state assigned" });

    const data = [];

    for (let i = 5; i >= 0; i--) {
      const start = startOfMonth(subMonths(new Date(), i));
      const end = endOfMonth(subMonths(new Date(), i));

      const apps = await prisma.inboxMessage.findMany({
        where: {
          timestamp: { gte: start, lte: end },
          receiverId: user?.id as string,
        },
        select: { status: true },
      });

      data.push({
        month: start.toLocaleString("default", { month: "short" }),
        approved: apps.filter((a) => a.status === "COMPLETED").length,
        rejected: apps.filter((a) => a.status === "REJECTED").length,
        pending: apps.filter((a) => a.status === "PENDING").length,
      });
    }

    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load trends" });
  }
};

export const getMyInboxTasks = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user.id;

    const tasks = await prisma.inboxMessage.findMany({
      where: {
        receiverId: userId,
        status: "PENDING",
      },
      orderBy: { timestamp: "desc" },
      include: {
        cofO: {
          select: {
            id: true,
            cofODocuments: true,
            user: true,
            createdAt: true,
            applicationNumber: true,
            status: true,
            land: {
              include: {
                documents: true,
                state: true,
              },
            },
          },
        },
      },
    });

    res.json(tasks);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load inbox tasks" });
  }
};

export const completeInboxTask = async (req: AuthRequest, res: Response) => {
  try {
    await prisma.inboxMessage.update({
      where: { id: req.params.id },
      data: { status: "DONE" },
    });

    res.json({ message: "Task completed" });
  } catch (e) {
    res.status(500).json({ message: "Failed to complete task" });
  }
};

export const approveDocumentForCofO = async (
  req: AuthRequest,
  res: Response,
) => {
  const { documentId } = req.params;
  const reviewerId = req.user.id;
  const { status } = req.body;
  try {
    const document = await prisma.cofODocument.findUnique({
      where: {
        id: documentId,
        inboxMessage: {
          internalUser: { id: reviewerId },
        },
      },
    });

    if (!document) {
      return res.status(401).json({
        message: "Document not found",
      });
    }

    if (status === "REJECTED") {
      const ApproveDocument = await prisma.cofODocument.update({
        where: {
          id: document.id,
        },
        data: {
          status: "REJECTED",
        },
      });

      return res.status(201).json({
        message: `Doument of ${ApproveDocument.title} has been rejected`,
      });
    }

    await prisma.cofODocument.update({
      where: {
        id: document.id,
      },
      data: {
        status: "APPROVED",
      },  
    });

    res.json({
      message: `Document of ${document.type} has been approved`,
    });
  } catch (error) {
     res.status(500).json({
      message: "Unexpected Error happened",
      error,
    });
  }
};

// controllers/reviewerController.ts
export const getReviewedApplications = async (
  req: AuthRequest,
  res: Response,
) => {
  const reviewerId = req.user.id;
  const apps = await prisma.inboxMessage.findMany({
    where: {
      receiverId: reviewerId,
      status: { in: ["COMPLETED", "REJECTED", "PENDING"] },
    },
    include: {
      cofO: {
        include: {
          user: true,
          land: { include: { state: true } },
          cofODocuments: true,
          approvalAudits: true,
        },
      },
    },
    orderBy: { timestamp: "desc" },
  });

  res.json(apps);
};
export const getCofOActivityLogs = async (req: AuthRequest, res: Response) => {
  const internalUserId = req.user.id;

  const user = await prisma.internalUser.findUnique({
    where: { id: internalUserId },
  });

  if (!user) {
    return res.status(404).json({
      message: "user not found",
    });
  }

  const logs = await prisma.cofOAuditLog.findMany({
    where: {
      cofO: {
        land: { stateId: user.stateId as string },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      cofO: true,
    },
  });

  res.json(logs);
};

export const getReviewerApplications = async (
  req: AuthRequest,
  res: Response,
) => {
  const reviewerId = req.user.id;

  const reviewer = await prisma.internalUser.findUnique({
    where: { id: reviewerId },
  });

  if (!reviewer) {
    return res.status(403).json({ message: "Not an internal user" });
  }

  const applications = await prisma.cofOApplication.findMany({
    where: {
      currentReviewerId: reviewerId,
      land: {
        stateId: reviewer.stateId as string, // 👈 join filter
      },
      status: { in: ["IN_REVIEW", "NEEDS_CORRECTION", "RESUBMITTED"] },
      InboxMessage: {
        every: {
          status: { in: ["PENDING", "COMPLETED", "REJECTED"] },
        },
      },
    },
    include: {
      user: true,
      land: {
        include: { state: true },
      },
      logs: true,
      cofODocuments: true,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(applications);
};
export const getCofOForReview = async (req: AuthRequest, res: Response) => {
  const reviewerId = req.user.id;
  const { id } = req.params;

  const reviewer = await prisma.internalUser.findUnique({
    where: { id: reviewerId },
  });

  if (!reviewer) return res.status(403).json({ message: "Unauthorized" });

  const app = await prisma.cofOApplication.findUnique({
    where: { id },
    include: {
      user: true,
      land: { include: { state: true } },
      cofODocuments: true,
      cofOAuditLogs: true,
      InboxMessage: true,
      approvalAudits: {
        include: { cofO: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!app) return res.status(404).json({ message: "Application not found" });

  // State-based access
  if (app.land.stateId !== reviewer.stateId) {
    return res.status(403).json({ message: "Access denied" });
  }

  res.json(app);
};

export const governorDashboard = async (req: AuthRequest, res: Response) => {
  const governorId = req.user.sub;

  const governor = await prisma.internalUser.findUnique({
    where: { id: governorId },
  });

  if (!governor) {
    return res.status(403).json({ message: "Not authorized" });
  }

  const applications = await prisma.cofOApplication.findMany({
    where: {
      land: {
        stateId: governor.stateId as string, // 👈 same join
      },
      status: "IN_REVIEW",
    },
    include: {
      user: true,
      land: true,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(applications);
};
