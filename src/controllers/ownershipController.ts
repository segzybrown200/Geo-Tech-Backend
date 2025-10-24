// src/controllers/ownershipController.ts
import { PrismaClient } from "@prisma/client";
import { sendEmail } from "../services/emailSevices";
import crypto from "crypto";
import { AuthRequest } from "../middlewares/authMiddleware";
import { Response } from "express";

const prisma = new PrismaClient();

export const initiateTransfer = async (req:AuthRequest, res:Response) => {
  const userId = req.user.id;
  const { landId, newOwnerEmail, emails = [], phones = [] } = req.body;

  try {
    // ✅ Step 1: confirm land belongs to current user
    const land = await prisma.landRegistration.findUnique({
      where: { id: landId },
    });

    if (!land || land.ownerId !== userId) {
      return res
        .status(403)
        .json({ message: "You are not the owner of this land." });
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    // ✅ Step 2: Create transfer record
    const transfer = await prisma.ownershipTransfer.create({
      data: {
        landId,
        currentOwnerId: userId,
        newOwnerEmail,
        expiresAt,
      },
    });

    // ✅ Step 3: Collect all channels (2 emails + 1 phone, or vice versa)
    const allChannels = [
      ...emails.map((e: string) => ({ type: "email", value: e })),
      ...phones.map((p: string) => ({ type: "phone", value: p })),
    ];

    const verifications = [];

    // ✅ Step 4: Generate and send unique codes to every channel
    for (const { type, value } of allChannels) {
      const code = crypto.randomInt(100000, 999999).toString();

      verifications.push({
        transferId: transfer.id,
        channelType: type,
        target: value,
        code,
        expiresAt,
      });

      if (type === "email") {
        await sendEmail(
          value,
          "Land Ownership Transfer Authorization",
          `<p>Hello,</p>
          <p>A request was made to transfer land ownership (ID: <b>${landId}</b>).</p>
          <p>Your authorization code is: <b>${code}</b></p>
          <p>This code expires in 15 minutes.</p>`
        );
      } else {
        // ⚠️ Replace this with actual SMS provider later (Twilio, Termii, etc.)
        console.log(`📱 SMS to ${value}: Your GeoTech transfer code is ${code}`);
      }
    }

    // ✅ Step 5: Save all codes
    await prisma.transferVerification.createMany({ data: verifications });

    res.status(201).json({
      message: "Authorization codes sent to all selected channels.",
      transferId: transfer.id,
      channels: allChannels.map((c) => c.value),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Failed to initiate ownership transfer.",
      error: err,
    });
  }
};

export const verifyTransferCode = async (req:AuthRequest, res:Response) => {
  const userId = req.user.id;
  const { transferId, target, code } = req.body;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
    });

    if (!transfer || transfer.currentOwnerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    const verification = await prisma.transferVerification.findFirst({
      where: { transferId, target },
    });

    if (!verification)
      return res.status(404).json({ message: "Verification not found" });

    if (verification.isVerified)
      return res.status(400).json({ message: "Already verified" });

    if (verification.code !== code)
      return res.status(400).json({ message: "Invalid code" });

    if (new Date() > verification.expiresAt)
      return res.status(400).json({ message: "Code expired" });

    await prisma.transferVerification.update({
      where: { id: verification.id },
      data: { isVerified: true },
    });

    // ✅ Check if all channels verified
    const remaining = await prisma.transferVerification.count({
      where: { transferId, isVerified: false },
    });

    if (remaining === 0) {
      await prisma.ownershipTransfer.update({
        where: { id: transferId },
        data: { status: "AUTHORIZED" },
      });
    }

    res.json({
      message: "Code verified successfully.",
      allVerified: remaining === 0,
      transferId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Verification failed", error: err });
  }
};
export const finalizeTransfer = async (req:AuthRequest, res:Response) => {
  const { transferId } = req.body;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
    });

    if (!transfer || transfer.status !== "AUTHORIZED")
      return res.status(400).json({ message: "Transfer not authorized yet" });

    const newOwner = await prisma.user.findUnique({
      where: { email: transfer.newOwnerEmail },
    });

    if (!newOwner)
      return res.status(404).json({ message: "New owner not found" });

    await prisma.landRegistration.update({
      where: { id: transfer.landId },
      data: { ownerId: newOwner.id },
    });

    await prisma.ownershipHistory.create({
      data: {
        landId: transfer.landId,
        fromUserId: transfer.currentOwnerId,
        toUserId: newOwner.id,
        authorizedBy: transfer.currentOwnerId,
      },
    });

    await prisma.ownershipTransfer.update({
      where: { id: transferId },
      data: { status: "COMPLETED" },
    });

    res.json({ message: "Ownership transfer completed successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Transfer finalization failed", error: err });
  }
};


