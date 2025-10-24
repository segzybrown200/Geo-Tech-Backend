// src/controllers/paymentController.ts
import axios from "axios";
import { Response,Request } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthRequest } from "../middlewares/authMiddleware";

const prisma = new PrismaClient();
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET!;

export const initializePayment = async (req:AuthRequest, res:Response) => {
  const { amount, landId } = req.body;
  const userId = req.user.id;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: user.email,
        amount: amount * 100, // Paystack uses kobo
        callback_url: "https://yourfrontend.com/payment/callback",
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
        },
      }
    );

    const { reference, authorization_url } = response.data.data;

    // create pending CofO application
    await prisma.cofOApplication.create({
      data: {
        userId,
        landId,
        paymentRef: reference,
        paymentStatus: "PENDING",
      },
    });

    res.json({ authorization_url, reference });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Payment initialization failed", error: err });
  }
};
// src/controllers/paymentController.ts
export const verifyPayment = async (req:Request, res:Response) => {
  const { reference } = req.query;

  try {
    const verify = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
      }
    );

    const payment = verify.data.data;

    if (payment.status !== "success")
      return res.status(400).json({ message: "Payment not successful" });

    const cofONumber = `COFO-${new Date().getFullYear()}-${Math.floor(
      Math.random() * 100000
    )}`;

    const application = await prisma.cofOApplication.updateMany({
      where: { paymentRef: reference as string },
      data: {
        paymentStatus: "SUCCESS",
        status: "PENDING",
        cofONumber,
      },
    });

    res.json({
      message: "Payment verified successfully. You can now upload documents.",
      cofONumber,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Payment verification failed", error: err });
  }
};
