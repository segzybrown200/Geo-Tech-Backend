import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { uploadToCloudinary, validateDocumentFile } from "../services/uploadService";
import { AuthRequest } from "../middlewares/authMiddleware";
import { cofoBatchSignSchema, cofoReviewSchema } from "../utils/zodSchemas";
import { sendEmail } from "../services/emailSevices";

export const applyForCofO = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user.sub;
    const { cofOApplicationId } = req.params;

    const files = req.files as Express.Multer.File[];

    if (!cofOApplicationId || !files?.length) {
      return res.status(400).json({
        message: "CofO ID and documents are required",
      });
    }

    // Validate each file before processing
    const validationErrors: string[] = [];
    files.forEach((file, index) => {
      const validation = validateDocumentFile(
        file.buffer,
        file.originalname,
        file.mimetype
      );
      if (!validation.valid) {
        validationErrors.push(`File ${index + 1} (${file.originalname}): ${validation.error}`);
      }
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({
        message: "Document validation failed",
        errors: validationErrors,
      });
    }

    const documents: { type: string; title: string }[] = JSON.parse(
      req.body.documentsMeta || "[]",
    );
    Object.keys(req.body).forEach((key) => {
      const match = key.match(/documents\[(\d+)\]\[(.+)\]/);
      if (match) {
        const index = parseInt(match[1]);
        const field = match[2];
        if (!documents[index]) {
          documents[index] = { type: "", title: "" };
        }
        documents[index][field as keyof (typeof documents)[0]] = req.body[key];
      }
    });

    if (documents.length !== files.length) {
      return res.status(400).json({
        message: "Documents metadata does not match uploaded files",
      });
    }

    const application = await prisma.cofOApplication.findUnique({
      where: { id: cofOApplicationId },
      include: { land: true },
    });
    if (!application) {
      return res.status(404).json({ message: "CofO application not found" });
    }
    if (application.userId !== userId) {
      return res.status(403).json({
        message: "You do not own this land",
      });
    }
    if (
      application.status !== "DRAFT" &&
      application.status !== "NEEDS_CORRECTION"
    ) {
      return res.status(400).json({
        message: "Application already submitted",
      });
    }
    const uploadResults = await Promise.all(
      files.map((file) => uploadToCloudinary(file.buffer, file.originalname, file.mimetype)),
    );

    const documentUrls = uploadResults.map((r) => r.secure_url);
    if (documentUrls.length === 0) {
      return res
        .status(500)
        .json({ message: "Document upload failed, try again" });
    }

    const approvers = await prisma.internalUser.findMany({
      where: { stateId: application.land.stateId },
      orderBy: { position: "asc" }, // 🔥 FIXED ORDER
    });
    if (!approvers || approvers.length === 0) {
      return res.status(500).json({
        message: "No approvers configured for this state's CofO workflow",
      });
    }
    const firstApprover = approvers[0];

    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < uploadResults.length; i++) {
        await tx.cofODocument.create({
          data: {
            cofOId: cofOApplicationId,
            type: documents[i].type,
            title: documents[i].title,
            url: uploadResults[i].secure_url,
          },
        });
      }
      await tx.cofOApplication.update({
        where: { id: cofOApplicationId },
        data: { status: "IN_REVIEW", currentReviewerId: firstApprover.id },
      });

      await tx.inboxMessage.create({
        data: {
          receiverId: firstApprover.id,
          cofOId: cofOApplicationId,
          status: "PENDING",
          messageLink: `CofO/${application.applicationNumber}`,
        },
      });

      await tx.cofOAuditLog.create({
        data: {
          cofOId: cofOApplicationId,
          action: "SUBMITTED",
          performedById: userId,
          performedByRole: "APPLICANT",
        },
      });
    });
    // Send notification email to first approver
    try {
      await sendEmail(
        firstApprover.email,
        "New CofO application awaiting your review",
        `
         <p>Hello ${firstApprover.name},</p>
        <p>A new Certificate of Occupancy application has been assigned to you.</p>
        <p><b>Application NUmber:</b> ${application.applicationNumber}</p>
          <p>Please log in to review and take action.</p>
        `,
      );
    } catch (e) {
      console.warn("email fail", e);
    }

    /** 8️⃣ RESPONSE */
    res.status(201).json({
      message: "C of O application submitted successfully",
      applicationNumber: application.applicationNumber,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ message: "Application failed", error: err });
  }
};

/**
 * Helper: fetch ordered approvers for a state's CofO workflow
 * Returns array ordered by some ordering field (createdAt ascending by default)
 */
async function getStateApprovers(stateId: string) {
  return prisma.internalUser.findMany({
    where: { stateId, role: { in: ["ADMIN", "GOVERNOR"] } },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Helper: create an inbox message for next reviewer
 */
async function enqueueInbox(
  receiverId: string,
  cofOId: string,
  documentList: any[],
) {
  return prisma.inboxMessage.create({
    data: {
      receiverId,
      cofOId,
      documentList: {
        connect: documentList.map((doc) => ({ id: doc.id })),
      },
      status: "PENDING",
      messageLink: `CofO/${cofOId}`,
    },
  });
}
export async function generateCofONumber() {
  const year = new Date().getFullYear();

  const last = await prisma.cofOApplication.findFirst({
    where: {
      applicationNumber: {
        startsWith: `COFO-${year}-`,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    select: { applicationNumber: true },
  });

  let next = 1;

  if (last?.applicationNumber) {
    const parts = last.applicationNumber.split("-");
    next = parseInt(parts[2], 10) + 1;
  }

  const padded = String(next).padStart(6, "0");
  return `COFO-${year}-${padded}`;
}

/**
 * POST /cofo/review/:id
 * Body: { action: 'APPROVE' | 'REJECT', message?: string, signatureUrl?: string }
 */

export const resubmitCofO = async (req: AuthRequest, res: Response) => {
  const userId = req.user.sub;
  const { cofOId } = req.params;
  const files = req.files as Express.Multer.File[];
  const documents = req.body.documents; // [{ docId, title, type }]

  // Validate each file before processing
  const validationErrors: string[] = [];
  files.forEach((file, index) => {
    const validation = validateDocumentFile(
      file.buffer,
      file.originalname,
      file.mimetype
    );
    if (!validation.valid) {
      validationErrors.push(`File ${index + 1} (${file.originalname}): ${validation.error}`);
    }
  });

  if (validationErrors.length > 0) {
    return res.status(400).json({
      message: "Document validation failed",
      errors: validationErrors,
    });
  }

  const cofO = await prisma.cofOApplication.findUnique({
    where: { id: cofOId },
    include: { cofODocuments: true, rejectedBy: true },
  });

  if (!cofO || cofO.userId !== userId)
    return res.status(403).json({ message: "Unauthorized" });

  if (cofO.status !== "NEEDS_CORRECTION")
    return res.status(400).json({ message: "Application not editable" });

  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < files.length; i++) {
      const upload = await uploadToCloudinary(
        files[i].buffer,
        files[i].originalname,
        files[i].mimetype,
      );

      await tx.cofODocument.update({
        where: { id: documents[i].docId },
        data: {
          url: upload.secure_url,
          title: documents[i].title,
          type: documents[i].type,
        },
      });
    }

    await tx.cofOApplication.update({
      where: { id: cofOId },
      data: {
        status: "RESUBMITTED",
        currentReviewerId: cofO.rejectedById,
      },
    });

    await tx.inboxMessage.create({
      data: {
        receiverId: cofO.rejectedById!,
        cofOId,
        status: "PENDING",
        messageLink: `CofO/${cofO.applicationNumber}`,
      },
    });

    await tx.cofOAuditLog.create({
      data: {
        cofOId,
        action: "RESUBMITTED",
        performedById: userId,
        performedByRole: "APPLICANT",
      },
    });
  });
  try {
    await sendEmail(
      cofO.rejectedBy?.email!,
      "CofO application resubmitted for your review",
      `
         <p>Hello ${cofO.rejectedBy?.name},</p>
        <p>The Certificate of Occupancy application with Application Number: ${cofO.applicationNumber} has been resubmitted and awaits your review.</p>
        <p>Please log in to review and take action.</p>
        `,
    );
  } catch (e) {
    console.warn("email fail", e);
  }

  res.json({ message: "Application resubmitted successfully" });
};

export const reviewCofO = async (req: AuthRequest, res: Response) => {
  const reviewer = req.user; // { id, role }
  const { id: cofOId } = req.params;
  const parse = cofoReviewSchema.safeParse(req.body);

  if (!parse.success) {
    return res
      .status(400)
      .json({ message: "Validation failed", errors: parse.error.flatten() });
  }
  const { action, message } = parse.data;

  try {
    // 1) Load CofO application, its land and state info
    const cofO = await prisma.cofOApplication.findUnique({
      where: { id: cofOId },
      include: {
        land: { include: { state: true } },
        user: true,
        logs: true,
        cofODocuments: true,
      },
    });
    if (!cofO)
      return res.status(404).json({ message: "CofO application not found" });

    const state = cofO.land?.state;
    if (!state)
      return res
        .status(500)
        .json({ message: "Associated state not found for this CofO" });

    // 2) Ensure reviewer is allowed: must be either
    //    - internal user in same state OR
    //    - governor (or admin) with rights
    const internalReviewer = await prisma.internalUser.findUnique({
      where: { id: reviewer.id },
    });
    if (!internalReviewer) {
      return res
        .status(403)
        .json({ message: "Only internal approvers can review CofO" });
    }
    if (internalReviewer.stateId !== state.id) {
      return res
        .status(403)
        .json({ message: "You are not an approver for this state" });
    }

    // 3) Check inbox: ensure there is a pending inbox message for this reviewer for this CofO
    const inbox = await prisma.inboxMessage.findFirst({
      where: { receiverId: reviewer.id, cofOId, status: "PENDING" },
    });
    if (!inbox) {
      // allow governor to sign at final step even if no explicit inbox (optional)
      return res.status(403).json({
        message: "No pending review found for you for this application",
      });
    }

    // 4) Append StageLog
    const stageNumber = (cofO.logs?.length ?? 0) + 1;
    await prisma.stageLog.create({
      data: {
        cofOId,
        internalUserId: reviewer.id,
        stageNumber,
        status: action === "APPROVE" ? "APPROVED" : "REJECTED",
        message: message ?? null,
        approvedAt: action === "APPROVE" ? new Date() : null,
      },
    });

    // 5) Mark current inbox entry as handled
    await prisma.inboxMessage.update({
      where: { id: inbox.id },
      data: { status: action === "APPROVE" ? "COMPLETED" : "REJECTED" },
    });

    // 6) If REJECT => set CofO status to REJECTED, notify applicant, and stop pipeline
    if (action === "REJECT") {
      await prisma.$transaction(async (tx) => {
        await tx.cofOApplication.update({
          where: { id: cofOId },
          data: {
            status: "NEEDS_CORRECTION",
            rejectedById: reviewer.id,
            currentReviewerId: reviewer.id,
          },
        });

        await tx.stageLog.create({
          data: {
            cofOId,
            internalUserId: reviewer.id,
            stageNumber: cofO.logs.length + 1,
            status: "REJECTED",
            message,
          },
        });
        await tx.inboxMessage.update({
          where: { id: inbox.id },
          data: { status: "REJECTED" },
        });
      });

      await sendEmail(
        cofO.user.email,
        `C of O with Application Number ${cofO.applicationNumber} requires correction`,
        `<p>${message}</p>`,
      );

      return res.json({ message: "Application returned for correction" });
    }

    // 7) APPROVED path: move to next approver OR finalize if last
    // get ordered approvers for this state
    const approvers = await getStateApprovers(state.id);
    // find index of current reviewer in approvers list
    const idx = approvers.findIndex((a) => a.id === reviewer.id);

    if (idx === -1) {
      // safety net
      return res
        .status(500)
        .json({ message: "Reviewer not present in state approver list" });
    }

    // decide next step:
    const isLastApprover = idx === approvers.length - 1;

    if (!isLastApprover) {
      const nextApprover = approvers[idx + 1];
      // enqueue inbox for next approver
      await enqueueInbox(nextApprover.id, cofOId, cofO.cofODocuments);
      // update CofO status to IN_REVIEW
      await prisma.cofOApplication.update({
        where: { id: cofOId },
        data: { status: "IN_REVIEW" },
      });

      // optional notify next approver
      try {
        await sendEmail(
          nextApprover.email,
          "New CofO application awaiting your review",
          `<p>You have a new C of O application awaiting review: <strong>${cofO.applicationNumber}</strong></p>`,
        );
      } catch (e) {
        console.warn("email fail", e);
      }

      return res.json({ message: "Approved and forwarded to next approver" });
    }

    // 8) If last approver, now involve Governor (final signature) logic
    // Read state governor
    const stateWithGovernor = await prisma.state.findUnique({
      where: { id: state.id },
      include: { governor: true },
    });

    // If governor exists and is different than the last approver, create an inbox for governor
    if (
      stateWithGovernor?.governor &&
      stateWithGovernor.governor.id !== reviewer.id
    ) {
      await enqueueInbox(
        stateWithGovernor.governor.id,
        cofOId,
        cofO.cofODocuments,
      );
      await prisma.cofOApplication.update({
        where: { id: cofOId },
        data: { status: "IN_REVIEW" },
      });

      // notify governor
      try {
        await sendEmail(
          stateWithGovernor.governor.email,
          "C of O pending your signature",
          `<p>CofO Application ${cofO.applicationNumber} has reached final stage and awaits your signature.</p>`,
        );
      } catch (e) {
        console.warn("notify governor fail", e);
      }

      return res.json({
        message: "Approved and sent to governor for final signature",
      });
    }

    // 9) If governor is the current reviewer (or no governor set), finalize approval
    await prisma.cofOApplication.update({
      where: { id: cofOId },
      data: { status: "APPROVED" },
    });

    // Optionally: generate CofO number, sign, watermark doc etc. Implementers can add extra logic here.
    // Example: create a generated cofONumber
    const cofONumber = `COFO-${new Date().getFullYear()}-${cofOId
      .slice(0, 8)
      .toUpperCase()}`;
    await prisma.cofOApplication.update({
      where: { id: cofOId },
      data: {
        /* store cofONumber or signature metadata if you have fields */
        cofONumber,
      },
    });

    // Notify applicant of final approval
    try {
      await sendEmail(
        cofO.user.email,
        "Your C of O application has been approved",
        `<p>Congratulations — your application ${cofO.id} has been APPROVED and finalized.</p>
         <p>CofO Number: ${cofONumber}</p>`,
      );
    } catch (e) {
      console.warn("notify applicant fail", e);
    }

    return res.json({ message: "Application fully approved and finalized" });
  } catch (err) {
    console.error("Review failed", err);
    res.status(500).json({ message: "Review failed", error: err });
  }
};
export const batchSignCofOs = async (req: AuthRequest, res: Response) => {
  const user = req.user;
  const parse = cofoBatchSignSchema.safeParse(req.body);
  if (!parse.success)
    return res
      .status(400)
      .json({ message: "Validation failed", errors: parse.error.flatten() });

  const { ids, signatureUrl } = parse.data;

  try {
    // ensure caller is governor internal user
    const internal = await prisma.internalUser.findUnique({
      where: { id: user.id },
    });
    if (!internal || internal.role !== "GOVERNOR")
      return res.status(403).json({ message: "Only governors can batch sign" });

    // Filter only CofOs in the governor's state and currently awaiting governor signature
    const cofOs = await prisma.cofOApplication.findMany({
      where: {
        id: { in: ids },
        status: "IN_REVIEW",
      },
      include: { land: true, user: true, logs: true },
    });

    // ensure all requested cofOs belong to the governor's state
    const invalid = cofOs.find((c) => c.land.stateId !== internal.stateId);
    if (invalid)
      return res
        .status(403)
        .json({ message: "One or more CofOs do not belong to your state" });

    const results: any[] = [];
    let effectiveSignatureUrl = signatureUrl;

    // 🔹 Use stored signature if user is governor and has one
    if (internal.role === "GOVERNOR") {
      if (internal.signatureUrl) {
        effectiveSignatureUrl = internal.signatureUrl;
      } else {
        return res.status(400).json({
          message:
            "Governor signature not found. Please upload your signature first.",
        });
      }
    }

    for (const cofO of cofOs) {
      // generate CofO number
      const cofONumber = await generateCofONumber();

      // update cofO
      await prisma.cofOApplication.update({
        where: { id: cofO.id },
        data: {
          status: "APPROVED",
          cofONumber,
          signedAt: new Date(),
          governorSignatureUrl: effectiveSignatureUrl,
        },
      });

      // create stage log entry
      await prisma.stageLog.create({
        data: {
          cofOId: cofO.id,
          internalUserId: internal.id,
          stageNumber: (cofO.logs?.length ?? 0) + 1,
          status: "APPROVED",
          message: "Batch-signed by governor",
          approvedAt: new Date(),
        },
      });

      // update any pending inbox messages for that cofO to COMPLETED
      await prisma.inboxMessage.updateMany({
        where: { cofOId: cofO.id, status: "PENDING" },
        data: { status: "COMPLETED" },
      });

      // notify applicant
      try {
        await sendEmail(
          cofO.user.email,
          "Your CofO has been signed",
          `<p>Your CofO ${cofO.id} is now approved. CofO Number: ${cofONumber}</p>`,
        );
      } catch (e) {
        console.warn("email fail", e);
      }

      results.push({ id: cofO.id, cofONumber });
    }

    return res.json({ message: "Batch sign complete", results });
  } catch (err) {
    console.error("batch sign failed", err);
    return res.status(500).json({ message: "Batch sign failed", error: err });
  }
};
export const getCofOById = async (req: Request, res: Response) => {
  const cofOId = req.params.cofOId;
  try {
    const cofO = await prisma.cofOApplication.findUnique({
      where: { id: cofOId },
      include: {
        land: true,
        user: true,
        logs: true,
        cofODocuments: true,
        InboxMessage: true,
        currentReviewer: true,
        approvedBy: true,
      },
    });
    if (!cofO) {
      return res.status(404).json({ message: "CofO application not found" });
    }
    res.status(200).json({ cofO });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error retrieving CofO application", error: err });
  }
};
export const getMyCofOApplications = async (req: AuthRequest, res: Response) => {
  const userId = req.user.sub;

  const applications = await prisma.cofOApplication.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      land: true,
      currentReviewer: true,
      logs: { orderBy: { arrivedAt: "asc" } },
    },
  });

  res.json(applications);
};