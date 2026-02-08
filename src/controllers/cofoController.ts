import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { uploadToCloudinary, validateDocumentFile } from "../services/uploadService";
import { AuthRequest } from "../middlewares/authMiddleware";
import { cofoBatchSignSchema, cofoReviewSchema } from "../utils/zodSchemas";
import { sendEmail } from "../services/emailSevices";
import { generateCofOCertificate } from "../utils/generateCofOCertificate";

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
      include: { land: true,user: true, payments: true },
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
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 680px; margin:auto; border:1px solid #eee; border-radius:8px;">
          <div style="background:#004CFF;color:#fff;padding:16px;text-align:center;"><h3>New CofO Application Assigned</h3></div>
          <div style="padding:16px;color:#222;line-height:1.5;">
            <p>Dear ${firstApprover.name},</p>
            <p>A new Certificate of Occupancy application has been assigned to you for review. Details are provided below for your reference.</p>
            <p><strong>Application Number:</strong> ${application.applicationNumber}</p>
            <p><strong>Applicant:</strong> ${application.user?.fullName ?? 'N/A'}</p>
            <p>Please log in to the GeoTech internal portal to inspect the submitted documents, validate the information, and record your decision. If you require any clarification or supporting documentation, please use the inbox/task interface to request it from the applicant or escalate as required.</p>
            <p>Thank you for attending to this matter promptly.</p>
            <p>Sincerely,<br/>GeoTech Administration</p>
          </div>
        </div>
      `;

      await sendEmail(firstApprover.email, "New CofO application awaiting your review", html);
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
  // Order approvers by their assigned `position` (review order), then
  // ensure the governor (final signer) is placed last in the returned list.
  const approvers = await prisma.internalUser.findMany({
    where: { stateId, role: "APPROVER" },
    orderBy: { position: "asc" },
  });

  const governor = await prisma.internalUser.findFirst({
    where: { stateId, role: "GOVERNOR" },
  });

  if (governor) approvers.push(governor);
  return approvers;
}

/**
 * Helper: create an inbox message for next reviewer
 */
async function enqueueInbox(
  receiverId: string,
  cofOId: string,
  applicationNumber: string,
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
      messageLink: `CofO/${applicationNumber}`,
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
  try {
    const userId = req.user.sub;
    const { cofOId } = req.params;
    const files = (req.files as Express.Multer.File[]) || [];

    // Frontend sends documents metadata as `documentsMeta` (stringified JSON)
    let documents: { docId: string; title?: string; type?: string }[] = [];
    try {
      documents = JSON.parse(req.body.documentsMeta || "[]");
    } catch (e) {
      return res.status(400).json({ message: "Invalid documents metadata" });
    }

    if (!files.length) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    if (documents.length !== files.length) {
      return res.status(400).json({ message: "Documents metadata does not match uploaded files" });
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

    const cofO = await prisma.cofOApplication.findUnique({
      where: { id: cofOId },
      include: { cofODocuments: true, rejectedBy: true },
    });

    if (!cofO || cofO.userId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    if (cofO.status !== "NEEDS_CORRECTION")
      return res.status(400).json({ message: "Application not editable" });

    // Ensure provided docIds belong to this CofO
    const docIds = documents.map((d) => d.docId);
    const existingDocs = await prisma.cofODocument.findMany({ where: { id: { in: docIds } } });
    if (existingDocs.length !== docIds.length || existingDocs.some((d) => d.cofOId !== cofOId)) {
      return res.status(400).json({ message: "One or more document ids are invalid for this application" });
    }

    if (!cofO.rejectedById) {
      return res.status(400).json({ message: "No reviewer found to resend to" });
    }

    // Upload files to Cloudinary OUTSIDE transaction to avoid timeout
    const uploadResults = await Promise.all(
      files.map((file) =>
        uploadToCloudinary(file.buffer, file.originalname, file.mimetype)
      )
    );

    // Now run DB updates in transaction
    await prisma.$transaction(
      async (tx) => {
        for (let i = 0; i < uploadResults.length; i++) {
          await tx.cofODocument.update({
            where: { id: documents[i].docId },
            data: {
              url: uploadResults[i].secure_url,
              title: documents[i].title ?? existingDocs.find((d) => d.id === documents[i].docId)!.title,
              type: documents[i].type ?? existingDocs.find((d) => d.id === documents[i].docId)!.type,
              status: "PENDING",
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
      },
      { timeout: 10000 } // Increase timeout to 10 seconds for safety
    );

      try {
      if (cofO.rejectedBy?.email) {
        const html = `
          <div style="font-family: Arial, sans-serif; max-width:680px;margin:auto;border:1px solid #eee;border-radius:8px;">
            <div style="background:#004CFF;color:#fff;padding:16px;text-align:center;"><h3>Resubmitted: CofO Application</h3></div>
            <div style="padding:16px;color:#222;line-height:1.5;">
              <p>Dear ${cofO.rejectedBy.name},</p>
              <p>The Certificate of Occupancy application that was previously returned for corrections has been resubmitted by the applicant. Please find the application details below and proceed to review the updated documents.</p>
              <p><strong>Application Number:</strong> ${cofO.applicationNumber}</p>
              <p>Please log in to the GeoTech portal to examine the revised documents and confirm whether the submission now meets the requirements.</p>
              <p>Regards,<br/>GeoTech Administration</p>
            </div>
          </div>
        `;

        await sendEmail(cofO.rejectedBy.email, "Resubmitted CofO application awaiting your review", html);
      }
    } catch (e) {
      console.warn("email fail", e);
    }

    return res.json({ message: "Application resubmitted successfully" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Resubmission failed", error: (err as any)?.message ?? err });
  }
};

export const reviewCofO = async (req: AuthRequest, res: Response) => {
  const {id, role} = req.user; // { id, role }
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
      where: { id: id },
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
    // check if governor role has a signature on file (optional, can be used for signing the PDF certificate later)
      if (internalReviewer.role === "GOVERNOR" && !internalReviewer.signatureUrl) {
        return res.status(400).json({
          message: "Governor signature not found. Please upload your signature before approving.",
        });
      }

    // 3) Check inbox: ensure there is a pending inbox message for this reviewer for this CofO
    const inbox = await prisma.inboxMessage.findFirst({
      where: { receiverId: id, cofOId, status: "PENDING" },
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
        internalUserId: id,
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

    // Record approval audit for this reviewer (captures both APPROVER and GOVERNOR actions)
    if (action === "APPROVE") {
      await prisma.cofOAuditLog.create({
        data: {
          cofOId,
          action: "APPROVED",
          performedById: id,
          performedByRole: internalReviewer.role,
        },
      });
    }

    // 6) If REJECT => set CofO status to REJECTED, notify applicant, and stop pipeline
    if (action === "REJECT") {
      await prisma.$transaction(async (tx) => {
        await tx.cofOApplication.update({
          where: { id: cofOId },
          data: {
            status: "NEEDS_CORRECTION",
            rejectedById: id,
            currentReviewerId: id,
          },
        });
      });

      const html = `
        <div style="font-family: Arial, sans-serif; max-width:680px;margin:auto;border:1px solid #eee;border-radius:8px;">
          <div style="background:#E63946;color:#fff;padding:16px;text-align:center;"><h3>Action Required: Application Requires Correction</h3></div>
          <div style="padding:16px;color:#222;line-height:1.5;">
            <p>Dear ${cofO.user.fullName ?? 'Applicant'},</p>
            <p>Upon review, your Certificate of Occupancy application (Application Number: <strong>${cofO.applicationNumber}</strong>) requires corrections before it can proceed. The reviewer has provided the following guidance:</p>
            <blockquote style="background:#f7f7f7;padding:12px;border-left:4px solid #E63946;">${message ?? 'No details provided'}</blockquote>
            <p>Please address the points listed above, upload the corrected documents, and resubmit the application through your account portal. After resubmission the application will return to the reviewer for re-evaluation.</p>
            <p>If you need assistance understanding the requested changes, contact support or respond via the application inbox.</p>
            <p>Sincerely,<br/>GeoTech Review Team</p>
          </div>
        </div>
      `;

      await sendEmail(cofO.user.email, `Action Required: Corrections needed for CofO ${cofO.applicationNumber}`, html);

      return res.json({ message: "Application returned for correction" });
    }

    // 7) APPROVED path: move to next approver OR finalize if last
    // get ordered approvers for this state
    const approvers = await getStateApprovers(state.id);
    // find index of current reviewer in approvers list
    const idx = approvers.findIndex((a) => a.id === id);

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
      await enqueueInbox(nextApprover.id, cofOId, cofO.applicationNumber as string, cofO.cofODocuments);
      // update CofO status to IN_REVIEW
      await prisma.cofOApplication.update({
        where: { id: cofOId },
        data: { status: "IN_REVIEW", currentReviewerId: nextApprover.id },
      });

      // optional notify next approver
      try {
        const html = `
          <div style="font-family: Arial, sans-serif; max-width:680px;margin:auto;border:1px solid #eee;border-radius:8px;">
            <div style="background:#004CFF;color:#fff;padding:16px;text-align:center;"><h3>New CofO Application Assigned</h3></div>
            <div style="padding:16px;color:#222;line-height:1.5;">
              <p>Dear ${nextApprover.name},</p>
              <p>You have been assigned a new Certificate of Occupancy application for review.</p>
              <p><strong>Application Number:</strong> ${cofO.applicationNumber}</p>
              <p>Please access the GeoTech internal portal to examine the submitted materials and render your decision according to the established review procedures.</p>
              <p>Thank you for your prompt attention.</p>
              <p>Sincerely,<br/>GeoTech Administration</p>
            </div>
          </div>
        `;

        await sendEmail(nextApprover.email, "New CofO application awaiting your review", html);
      } catch (e) {
        console.warn("email fail", e);
      }

      return res.json({ message: "Approved and forwarded to next approver" });
    }

    // 8) If last approver, now involve Governor (final signature) logic
    // 9) Check if current user is GOVERNOR role - only then finalize
    if (internalReviewer.role === "GOVERNOR") {
      // Governor is approving - finalize immediately
    await prisma.cofOApplication.update({
      where: { id: cofOId },
      data: { status: "APPROVED",approvedById: id, signedAt: new Date(), governorSignatureUrl: internalReviewer.signatureUrl || null, },
    });

    // Optionally: generate CofO number, sign, watermark doc etc. Implementers can add extra logic here.
    // Example: create a generated cofONumber
    const cofONumber = `COFO-${new Date().getFullYear()}-${cofOId
      .slice(0, 8)
      .toUpperCase()}`;
    
    // Fetch the updated CofO with all necessary data for PDF generation
    const updatedCofO = await prisma.cofOApplication.findUnique({
      where: { id: cofOId },
      include: {
        user: true,
        land: {
          include: {
            state: true,
          },
        },
        approvedBy: true,
      },
    });

    let certificateUrl: string | null = null;
    
    // Generate PDF certificate automatically
    try {
      if (updatedCofO) {
        const certificateData = {
          applicationNumber: updatedCofO.applicationNumber || updatedCofO.id,
          cofONumber: cofONumber,
          user: {
            fullName: updatedCofO.user.fullName || "Unknown",
            email: updatedCofO.user.email,
            phone: updatedCofO.user.phone || undefined,
          },
          land: {
            address: updatedCofO.land.address || "Not specified",
            plotNumber: updatedCofO.land.plotNumber || "Not specified",
            state: {
              name: updatedCofO.land.state.name,
            },
            squareMeters: updatedCofO.land.squareMeters,
            ownershipType: updatedCofO.land.ownershipType,
            purpose: updatedCofO.land.purpose,
            latitude: updatedCofO.land.latitude,
            longitude: updatedCofO.land.longitude,
          },
          signedAt: new Date(),
          governorSignatureUrl: cofO.governorSignatureUrl || undefined,
          approvedBy: internalReviewer ? {
            name: internalReviewer.name,
            position: "Governor",
          } : undefined,
        };

        certificateUrl = await generateCofOCertificate(certificateData);
      }
    } catch (e) {
      console.warn("Certificate generation failed", e);
    }

    // Update cofO with number
    await prisma.cofOApplication.update({
      where: { id: cofOId },
      data: {
        cofONumber,
        // certificateUrl will be stored after schema migration
        certificateUrl,
        plotNumber: req.body.plotNumber || null,
      },
    });

    await prisma.cofOAuditLog.create({
      data: {
        cofOId,
        action: "FINALIZED",
        performedById: id,
        performedByRole: "GOVERNOR",
      },
    });

    await prisma.inboxMessage.updateMany({

      where: { cofOId, status: "PENDING" },
      data: { status: "COMPLETED" },
    });
    await prisma.landRegistration.update({
      where: { id: cofO.landId },
      data: { plotNumber: req.body.plotNumber || null },
    });
    // Notify applicant of final approval
    try {
      const html = `
        <div style="font-family: Arial, sans-serif; max-width:680px;margin:auto;border:1px solid #eee;border-radius:8px;">
          <div style="background:#0B8457;color:#fff;padding:16px;text-align:center;"><h3>Certificate of Occupancy — Approved</h3></div>
          <div style="padding:16px;color:#222;line-height:1.5;">
            <p>Dear ${cofO.user.fullName ?? 'Applicant'},</p>
            <p>We are pleased to inform you that your Certificate of Occupancy application has been approved and finalized.</p>
            <p><strong>Application Number:</strong> ${cofO.applicationNumber}</p>
            <p><strong>CofO Number:</strong> ${cofONumber}</p>
            ${certificateUrl ? `<p>You may download your official Certificate of Occupancy using the link below:</p><p><a href="${certificateUrl}">Download Certificate of Occupancy</a></p>` : '<p>The official certificate will be available in your account shortly.</p>'}
            <p>Please retain this document for your records. If you require any further assistance or require certified copies, contact GeoTech Support.</p>
            <p>Sincerely,<br/>GeoTech Registry Office</p>
          </div>
        </div>
      `;

      await sendEmail(cofO.user.email, "GeoTech — Your CofO application has been approved", html);
    } catch (e) {
      console.warn("notify applicant fail", e);
    }

    return res.json({ 
      message: "Application fully approved and finalized",
      cofONumber,
      certificateUrl: certificateUrl || null,
    });
    } else {
      // Current user is APPROVER and is last in list - need to forward to governor or error
      const stateWithGovernor = await prisma.state.findUnique({
        where: { id: state.id },
        include: { governor: true },
      });

      // If governor exists, forward approval to governor
      if (stateWithGovernor?.governor) {
        await enqueueInbox(
          stateWithGovernor.governor.id,
          cofOId,
          cofO.applicationNumber as string,
          cofO.cofODocuments,
        );
        await prisma.cofOApplication.update({
          where: { id: cofOId },
          data: { status: "IN_REVIEW", currentReviewerId: stateWithGovernor.governor.id },
        });

        // notify governor
        try {
          const html = `
            <div style="font-family: Arial, sans-serif; max-width:680px;margin:auto;border:1px solid #eee;border-radius:8px;">
              <div style="background:#004CFF;color:#fff;padding:16px;text-align:center;"><h3>CofO Application Awaiting Signature</h3></div>
              <div style="padding:16px;color:#222;line-height:1.5;">
                <p>Dear ${stateWithGovernor.governor.name},</p>
                <p>The Certificate of Occupancy application identified below has completed the internal review stages and requires your final signature to be finalized.</p>
                <p><strong>Application Number:</strong> ${cofO.applicationNumber}</p>
                <p>Please review the application and, if satisfied, apply your signature via the governor workflow in the GeoTech portal.</p>
                <p>If you have questions about the package, consult the review history or contact the relevant approver.</p>
                <p>Respectfully,<br/>GeoTech Administration</p>
              </div>
            </div>
          `;

          await sendEmail(stateWithGovernor.governor.email, "C of O pending your signature", html);
        } catch (e) {
          console.warn("notify governor fail", e);
        }

        return res.json({
          message: "Approved and sent to governor for final signature",
        });
      } else {
        // No governor exists - cannot finalize as approver
        return res.status(400).json({
          message: "Cannot approve: No governor configured for this state to finalize the certificate",
        });
      }
    }
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
      include: { 
        land: {
          include: {
            state: true,
          },
        }, 
        user: true, 
        logs: true 
      },
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

      // Generate PDF certificate for the approved CofO
      let certificateUrl: string | null = null;
      try {
        const certificateData = {
          applicationNumber: cofO.applicationNumber || cofO.id,
          cofONumber: cofONumber,
          user: {
            fullName: cofO.user.fullName || "Unknown",
            email: cofO.user.email,
            phone: cofO.user.phone || undefined,
          },
          land: {
            address: cofO.land.address || "Not specified",
            plotNumber: req.body.plotNumber || cofO.land.plotNumber || "Not specified",
            state: {
              name: cofO.land.state.name,
            },
            squareMeters: cofO.land.squareMeters,
            ownershipType: cofO.land.ownershipType,
            purpose: cofO.land.purpose,
            latitude: cofO.land.latitude,
            longitude: cofO.land.longitude,
          },
          signedAt: new Date(),
          governorSignatureUrl: effectiveSignatureUrl,
          approvedBy: internal ? {
            name: internal.name,
            position: String(internal.position || "Governor"),
          } : undefined,
        };

        certificateUrl = await generateCofOCertificate(certificateData);
        
        // Certificate URL will be stored after schema migration
        await prisma.cofOApplication.update({
          where: { id: cofO.id },
          data: {
            certificateUrl,
          },
        });
      } catch (e) {
        console.warn(`Certificate generation failed for ${cofO.id}:`, e);
      }

      // notify applicant
      try {
        const html = `
          <div style="font-family: Arial, sans-serif; max-width:680px;margin:auto;border:1px solid #eee;border-radius:8px;">
            <div style="background:#0B8457;color:#fff;padding:16px;text-align:center;"><h3>Certificate of Occupancy Issued</h3></div>
            <div style="padding:16px;color:#222;line-height:1.5;">
              <p>Dear ${cofO.user.fullName || 'Applicant'},</p>
              <p>Your Certificate of Occupancy application has been approved and the document has been signed.</p>
              <p><strong>Application Number:</strong> ${cofO.applicationNumber}</p>
              <p><strong>CofO Number:</strong> ${cofONumber}</p>
              ${certificateUrl ? `<p>You may download your official Certificate of Occupancy using the link below:</p><p><a href="${certificateUrl}">Download Certificate of Occupancy</a></p>` : '<p>The official certificate will be available in your account shortly.</p>'}
              <p>If you require notarized or certified copies, please contact GeoTech Support for further assistance.</p>
              <p>Sincerely,<br/>GeoTech Registry Office</p>
            </div>
          </div>
        `;

        await sendEmail(cofO.user.email, "GeoTech — Your CofO has been issued", html);
      } catch (e) {
        console.warn("email fail", e);
      }

      results.push({ id: cofO.id, cofONumber, certificateUrl });
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

// List CofOs for governor of their state
// export const listCofOsForGovernor = async (req: any, res: Response) => {
//   try {
//     const user = req.user;
//     const internal = await prisma.internalUser.findUnique({ where: { id: user.id } });
//     if (!internal || internal.role !== "GOVERNOR")
//       return res.status(403).json({ message: "Only governors can access this resource" });

//     const cofOs = await prisma.cofOApplication.findMany({
//       where: {
//         land: { stateId: internal.stateId as string },
//         status: { in: ["IN_REVIEW", "RESUBMITTED", "APPROVED", "NEEDS_CORRECTION", "DRAFT"] },
//       },
//       orderBy: { createdAt: "desc" },
//       include: { land: true, user: true, logs: true, cofODocuments: true },
//     });

//     return res.json({ results: cofOs });
//   } catch (err) {
//     console.error("listCofOsForGovernor failed", err);
//     return res.status(500).json({ message: "Failed to fetch CofOs", error: err });
//   }
// };

// Get one CofO for governor ensuring it belongs to governor's state
export const getCofOForGovernor = async (req: any, res: Response) => {
  try {
    const { cofOId } = req.params;
    const user = req.user;
    const internal = await prisma.internalUser.findUnique({ where: { id: user.id } });
    if (!internal || internal.role !== "GOVERNOR")
      return res.status(403).json({ message: "Only governors can access this resource" });

    const cofO = await prisma.cofOApplication.findUnique({
      where: { id: cofOId },
      include: { land: true, user: true, logs: true, cofODocuments: true, currentReviewer: true },
    });
    if (!cofO) return res.status(404).json({ message: "CofO application not found" });
    if (cofO.land.stateId !== internal.stateId)
      return res.status(403).json({ message: "This CofO does not belong to your state" });

    return res.json({ cofO });
  } catch (err) {
    console.error("getCofOForGovernor failed", err);
    return res.status(500).json({ message: "Failed to fetch CofO", error: err });
  }
};

const ALLOWED_STATUSES = [
  "IN_REVIEW",
  "RESUBMITTED",
  "APPROVED",
  "NEEDS_CORRECTION",
  "DRAFT",
];



export const listCofOsForGovernor = async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user?.id) return res.status(401).json({ message: "Unauthorized" });

    const internal = await prisma.internalUser.findUnique({ where: { id: user.id } });
    if (!internal || internal.role !== "GOVERNOR")
      return res.status(403).json({ message: "Only governors can access this resource" });

    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
    const skip = (page - 1) * limit;

    const statuses = (req.query.status
      ? String(req.query.status).split(",").map(s => s.trim()).filter(Boolean)
      : ALLOWED_STATUSES) as any[];

    const baseWhere = {
      land: { stateId: internal.stateId as string },
      status: { in: statuses as any },
    };

    const [total, cofOs] = await prisma.$transaction([
      prisma.cofOApplication.count({ where: baseWhere }),
      prisma.cofOApplication.findMany({
        where: baseWhere,
        orderBy: { createdAt: "desc" },
        include: { land: true, user: true, logs: true, cofODocuments: true, currentReviewer: true },
        skip,
        take: limit,
      }),
    ]);

    return res.json({
      meta: { total, page, limit },
      results: cofOs,
    });
  } catch (err) {
    console.error("listCofOsForGovernor failed", err);
    return res.status(500).json({ message: "Failed to fetch CofOs" });
  }
};
