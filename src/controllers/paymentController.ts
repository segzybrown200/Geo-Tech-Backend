// src/controllers/paymentController.ts
import axios from "axios";
import { Response, Request } from "express";
import { AuthRequest } from "../middlewares/authMiddleware";

import prisma from "../lib/prisma";
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET!;

export const initializePayment = async (req: AuthRequest, res: Response) => {
  const { amount, landID } = req.body;
  const userId = req.user.id;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: user.email,
        amount: amount * 100, // Paystack uses kobo
        metadata: { landID },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
        },
      }
    );

    const { reference, authorization_url } = response.data.data;

    await prisma.payment.create({
      data: {
        userId,
        amount,
        landId: landID,
        reference,
        status: "PENDING",
        provider: "PAYSTACK",
      },
    });

    res.json({ authorization_url, reference });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ message: "Payment initialization failed", error: err });
  }
};
// src/controllers/paymentController.ts
export const verifyPayment = async (req: Request, res: Response) => {
  const { reference } = req.query;

  try {
    const verify = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
      }
    );

    const paymentData = verify.data.data;

    if (paymentData.status !== "success") {
      return res.status(400).json({ message: "Payment not successful" });
    }
    const payment = await prisma.payment.findUnique({
      where: { reference: String(reference) },
    });
    if (!payment) {
      return res.status(404).json({ message: "Payment record not found" });
    }



    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "SUCCESS" },
    });
    const cofO = await prisma.cofOApplication.create({
      data: {
        userId: payment.userId,
        landId: payment.landId,
        status: "DRAFT",
      },
    });
      const applicationNumber = `COFO-${new Date().getFullYear()}-${cofO.id}`;

    await prisma.cofOApplication.update({
      where: { id: cofO.id },
      data: { applicationNumber },
    });
    res.json({
      message: "Payment verified successfully. You can now upload documents.",
      cofOApplicationId: cofO.id,
      applicationNumber,
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ message: "Payment verification failed", error: err });
  }
};
