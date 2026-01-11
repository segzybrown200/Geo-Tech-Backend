import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { uploadToCloudinary } from "../services/uploadService";
import fs from "fs";
import path from "path";
import { AuthRequest } from "../middlewares/authMiddleware";
import { cofoApplySchema, cofoBatchSignSchema, cofoReviewSchema } from "../utils/zodSchemas";
import { sendEmail } from "../services/emailSevices";


export const applyForCofO = async (req: AuthRequest, res: Response) => {
    try {

  const userId = req.user.id;
  const body = cofoApplySchema.safeParse(req.body);
  if (!body.success) {
    return res
      .status(400)
      .json({
        message: "Invalid application data",
        errors: body.error.flatten(),
      });
  }

  const { landId } = body.data;
  const files = req.files as Express.Multer.File[];

  if (!landId || files.length === 0) {
    return res
      .status(400)
      .json({ message: "Land ID and documents are required" });
  }
  const land = await prisma.landRegistration.findUnique({
    where: { id: landId },
    include: { state: true },
  });

  if (!land) return res.status(404).json({ message: "Land not found" });

  
    if (land.ownerId !== userId) {
      return res.status(403).json({
        message: "You do not own this land",
      });
    }
    const existingApplication = await prisma.cofOApplication.findFirst({
      where: {
        landId,
        status: {
          in: ["IN_REVIEW", "PENDING", "APPROVED"],
        },
      },
    });

    if (existingApplication) {
      return res.status(409).json({
        message: "A C of O application already exists for this land",
      });
    }

    const uploadResults = await Promise.all(
      files.map((file) =>
        uploadToCloudinary(
          fs.readFileSync(path.resolve(file.path)),
          file.originalname
        )
      )
    );

    const documentUrls = uploadResults.map((r) => r.secure_url);

    const approvers = await prisma.internalUser.findMany({
      where: { function: "CofO Approval" },
      orderBy: { createdAt: "asc" },
    });

    

   const cofOApplication = await prisma.$transaction(async (tx) => {
      const application = await tx.cofOApplication.create({
        data: {
          userId,
          landId,
          documentUrls,
          status: "PENDING",
        },
      });

      if (approvers.length > 0) {
        await tx.inboxMessage.create({
          data: {
            receiverId: approvers[0].id,
            cofOId: application.id,
            documentList: documentUrls,
            status: "PENDING",
            messageLink: `CofO/${application.id}`,
          },
        });
      }

      return application;
    });

    /** 8️⃣ RESPONSE */
    return res.status(201).json({
      message: "C of O application submitted successfully",
      application: cofOApplication,
    });
  } catch (err) {
    return res.status(500).json({ message: "Application failed", error: err });
  }
};


/**
 * Helper: fetch ordered approvers for a state's CofO workflow
 * Returns array ordered by some ordering field (createdAt ascending by default)
 */
async function getStateApprovers(stateId: string) {
  return prisma.internalUser.findMany({
    where: { stateId, role: { in: ['ADMIN', 'GOVERNOR'] } },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Helper: create an inbox message for next reviewer
 */
async function enqueueInbox(receiverId: string, cofOId: string, documentList: string[]) {
  return prisma.inboxMessage.create({
    data: {
      receiverId,
      cofOId,
      documentList,
      status: 'PENDING',
      messageLink: `CofO/${cofOId}`
    }
  });
}
export async function generateCofONumber() {
  // get next sequence value from Postgres, safe for concurrency
  // Prisma raw query returns [{ nextval: '1' }] shape or DB-dependent; use $queryRawUnsafe
  const result = await prisma.$queryRawUnsafe<{ nextval: string }[]>(
    `SELECT nextval('cofo_number_seq') as nextval`
  );

  const next = result?.[0]?.nextval;
  const n = parseInt(next, 10);
  const year = new Date().getFullYear();
  const padded = String(n).padStart(6, '0');
  return `COFO-${year}-${padded}`;
}

/**
 * POST /cofo/review/:id
 * Body: { action: 'APPROVE' | 'REJECT', message?: string, signatureUrl?: string }
 */
export const reviewCofO = async (req: AuthRequest, res: Response) => {
  const reviewer = req.user; // { id, role }
  const { id: cofOId } = req.params;
  const parse = cofoReviewSchema.safeParse(req.body);

  if (!parse.success) {
    return res.status(400).json({ message: 'Validation failed', errors: parse.error.flatten() });
  }
  const { action, message, signatureUrl } = parse.data;

  try {
    // 1) Load CofO application, its land and state info
    const cofO = await prisma.cofOApplication.findUnique({
      where: { id: cofOId },
      include: { land: { include: { state: true } }, user: true, logs: true }
    });
    if (!cofO) return res.status(404).json({ message: 'CofO application not found' });

    const state = cofO.land?.state;
    if (!state) return res.status(500).json({ message: 'Associated state not found for this CofO' });

    // 2) Ensure reviewer is allowed: must be either
    //    - internal user in same state OR
    //    - governor (or admin) with rights
    const internalReviewer = await prisma.internalUser.findUnique({ where: { id: reviewer.id } });
    if (!internalReviewer) {
      return res.status(403).json({ message: 'Only internal approvers can review CofO' });
    }
    if (internalReviewer.stateId !== state.id) {
      return res.status(403).json({ message: 'You are not an approver for this state' });
    }

    // 3) Check inbox: ensure there is a pending inbox message for this reviewer for this CofO
    const inbox = await prisma.inboxMessage.findFirst({
      where: { receiverId: reviewer.id, cofOId, status: 'PENDING' }
    });
    if (!inbox) {
      // allow governor to sign at final step even if no explicit inbox (optional)
      return res.status(403).json({ message: 'No pending review found for you for this application' });
    }

    // 4) Append StageLog
    const stageNumber = (cofO.logs?.length ?? 0) + 1;
    await prisma.stageLog.create({
      data: {
        cofOId,
        internalUserId: reviewer.id,
        stageNumber,
        status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        message: message ?? null,
        approvedAt: action === 'APPROVE' ? new Date() : null
      }
    });

    // 5) Mark current inbox entry as handled
    await prisma.inboxMessage.update({
      where: { id: inbox.id },
      data: { status: action === 'APPROVE' ? 'COMPLETED' : 'REJECTED' }
    });

    // 6) If REJECT => set CofO status to REJECTED, notify applicant, and stop pipeline
    if (action === 'REJECT') {
      await prisma.cofOApplication.update({ where: { id: cofOId }, data: { status: 'REJECTED' } });

      // optional: send email to applicant with rejection message
      try {
        await sendEmail(
          cofO.user.email,
          'Your C of O application was rejected',
          `<p>Your application ${cofO.id} was rejected by ${internalReviewer.name}.</p>
           <p>Reason: ${message ?? 'No reason provided'}</p>`
        );
      } catch (e) {
        // swallow email errors; not fatal
        console.warn('Failed to send rejection email', e);
      }

      return res.json({ message: 'Application rejected and applicant notified.' });
    }

    // 7) APPROVED path: move to next approver OR finalize if last
    // get ordered approvers for this state
    const approvers = await getStateApprovers(state.id);
    // find index of current reviewer in approvers list
    const idx = approvers.findIndex(a => a.id === reviewer.id);

    if (idx === -1) {
      // safety net
      return res.status(500).json({ message: 'Reviewer not present in state approver list' });
    }

    // decide next step:
    const isLastApprover = idx === approvers.length - 1;

    if (!isLastApprover) {
      const nextApprover = approvers[idx + 1];
      // enqueue inbox for next approver
      await enqueueInbox(nextApprover.id, cofOId, cofO.documentUrls);
      // update CofO status to IN_REVIEW
      await prisma.cofOApplication.update({ where: { id: cofOId }, data: { status: 'IN_REVIEW' } });

      // optional notify next approver
      try {
        await sendEmail(
          nextApprover.email,
          'New CofO application awaiting your review',
          `<p>You have a new C of O application awaiting review: <strong>${cofO.id}</strong></p>`
        );
      } catch (e) { console.warn('email fail', e); }

      return res.json({ message: 'Approved and forwarded to next approver' });
    }

    // 8) If last approver, now involve Governor (final signature) logic
    // Read state governor
    const stateWithGovernor = await prisma.state.findUnique({
      where: { id: state.id },
      include: { governor: true }
    });

    // If governor exists and is different than the last approver, create an inbox for governor
    if (stateWithGovernor?.governor && stateWithGovernor.governor.id !== reviewer.id) {
      await enqueueInbox(stateWithGovernor.governor.id, cofOId, cofO.documentUrls);
      await prisma.cofOApplication.update({ where: { id: cofOId }, data: { status: "IN_REVIEW" } });

      // notify governor
      try {
        await sendEmail(
          stateWithGovernor.governor.email,
          'C of O pending your signature',
          `<p>CofO ${cofO.id} has reached final stage and awaits your signature.</p>`
        );
      } catch (e) { console.warn('notify governor fail', e); }

      return res.json({ message: 'Approved and sent to governor for final signature' });
    }

    // 9) If governor is the current reviewer (or no governor set), finalize approval
    await prisma.cofOApplication.update({ where: { id: cofOId }, data: { status: 'APPROVED' } });

    // Optionally: generate CofO number, sign, watermark doc etc. Implementers can add extra logic here.
    // Example: create a generated cofONumber
    const cofONumber = `COFO-${new Date().getFullYear()}-${cofOId.slice(0,8).toUpperCase()}`;
    await prisma.cofOApplication.update({
      where: { id: cofOId },
      data: { /* store cofONumber or signature metadata if you have fields */ }
    });

    // Notify applicant of final approval
    try {
      await sendEmail(
        cofO.user.email,
        'Your C of O application has been approved',
        `<p>Congratulations — your application ${cofO.id} has been APPROVED and finalized.</p>
         <p>CofO Number: ${cofONumber}</p>`
      );
    } catch (e) { console.warn('notify applicant fail', e); }

    return res.json({ message: 'Application fully approved and finalized' });
  } catch (err) {
    console.error('Review failed', err);
    res.status(500).json({ message: 'Review failed', error: err });
  }
};
export const batchSignCofOs = async (req: AuthRequest, res:Response) => {
  const user = req.user;
  const parse = cofoBatchSignSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ message: 'Validation failed', errors: parse.error.flatten() });

  const { ids, signatureUrl } = parse.data;

  try {
    // ensure caller is governor internal user
    const internal = await prisma.internalUser.findUnique({ where: { id: user.id }});
    if (!internal || internal.role !== 'GOVERNOR') return res.status(403).json({ message: 'Only governors can batch sign' });

    // Filter only CofOs in the governor's state and currently awaiting governor signature
    const cofOs = await prisma.cofOApplication.findMany({
      where: {
        id: { in: ids },
        status: 'IN_REVIEW'
      },
      include: { land: true, user: true, logs: true }
    });

    // ensure all requested cofOs belong to the governor's state
    const invalid = cofOs.find(c => c.land.stateId !== internal.stateId);
    if (invalid) return res.status(403).json({ message: 'One or more CofOs do not belong to your state' });

    const results: any[] = [];
    let effectiveSignatureUrl = signatureUrl;

// 🔹 Use stored signature if user is governor and has one
if (internal.role === 'GOVERNOR') {
  if (internal.signatureUrl) {
    effectiveSignatureUrl = internal.signatureUrl;
  } else {
    return res.status(400).json({
      message: 'Governor signature not found. Please upload your signature first.'
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
          status: 'APPROVED',
          cofONumber,
          signedAt: new Date(),
          governorSignatureUrl: effectiveSignatureUrl,
          
        }
      });

      // create stage log entry
      await prisma.stageLog.create({
        data: {
          cofOId: cofO.id,
          internalUserId: internal.id,
          stageNumber: (cofO.logs?.length ?? 0) + 1,
          status: 'APPROVED',
          message: 'Batch-signed by governor',
          approvedAt: new Date()
        }
      });

      // update any pending inbox messages for that cofO to COMPLETED
      await prisma.inboxMessage.updateMany({
        where: { cofOId: cofO.id, status: 'PENDING' },
        data: { status: 'COMPLETED' }
      });

      // notify applicant
      try {
        await sendEmail(cofO.user.email, 'Your CofO has been signed', `<p>Your CofO ${cofO.id} is now approved. CofO Number: ${cofONumber}</p>`);
      } catch (e) { console.warn('email fail', e); }

      results.push({ id: cofO.id, cofONumber });
    }

    return res.json({ message: 'Batch sign complete', results });
  } catch (err) {
    console.error('batch sign failed', err);
    return res.status(500).json({ message: 'Batch sign failed', error: err });
  }
};
export const getCofOById = async (req: Request, res: Response) => {
  const cofOId = req.params.id;
  try {
    const cofO = await prisma.cofOApplication.findUnique({
      where: { id: cofOId },
      include: { land: true, user: true, logs: true }
    });
    if (!cofO) {
      return res.status(404).json({ message: "CofO application not found" });
    } 
    res.status(200).json({ cofO });
  } catch (err) {
    res.status(500).json({ message: "Error retrieving CofO application", error: err });
  }
};
