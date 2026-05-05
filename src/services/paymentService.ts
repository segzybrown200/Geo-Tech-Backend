import axios from "axios";
import prisma from "../lib/prisma";
import { PaymentStatus } from "../generated/client/client";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET!;

export interface PaymentInitData {
  userId: string;
  amount: number;
  type: "LAND_REGISTRATION" | "COFO";
  landId?: string;
  cofOId?: string;
  provider: string;
}

/**
 * Create a payment record for land registration
 */
export async function createLandRegistrationPayment(
  userId: string,
  landId: string,
  amount: number,
  provider: string,
  reference: string
): Promise<any> {
  try {
    const payment = await prisma.payment.create({
      data: {
        userId,
        landId,
        amount,
        provider,
        reference,
        type: "LAND_REGISTRATION",
        status: "PENDING",
      },
    });
    return payment;
  } catch (error) {
    console.error("Error creating land registration payment:", error);
    throw error;
  }
}

/**
 * Create a payment record for C of O
 */
export async function createCofOPayment(
  userId: string,
  cofOId: string,
  amount: number,
  provider: string,
  reference: string
): Promise<any> {
  try {
    const payment = await prisma.payment.create({
      data: {
        userId,
        cofOId,
        amount,
        provider,
        reference,
        type: "COFO",
        status: "PENDING",
      },
    });
    return payment;
  } catch (error) {
    console.error("Error creating C of O payment:", error);
    throw error;
  }
}

/**
 * Initialize land registration payment with Paystack
 */
export async function initializeLandRegistrationPayment(
  userId: string,
  amount: number,
  landId?: string
): Promise<any> {
  try {
    // Get user email for Paystack
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // Initialize payment with Paystack
    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: user.email,
        amount: amount * 100, // Convert to kobo
        reference: `LAND_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        metadata: {
          type: "LAND_REGISTRATION",
          landId,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    const { reference, authorization_url } = paystackResponse.data.data;

    // Create payment record
    const payment = await prisma.payment.create({
      data: {
        userId,
        landId,
        amount,
        provider: "PAYSTACK",
        reference,
        status: "PENDING",
        type: "LAND_REGISTRATION",
      },
    });

    return {
      payment,
      authorization_url,
      reference,
    };
  } catch (error) {
    console.error("Error initializing land registration payment:", error);
    throw error;
  }
}

/**
 * Update payment status
 */
export async function updatePaymentStatus(
  paymentId: string,
  status: PaymentStatus
): Promise<any> {
  try {
    const payment = await prisma.payment.update({
      where: { id: paymentId },
      data: { status },
    });
    return payment;
  } catch (error) {
    console.error("Error updating payment status:", error);
    throw error;
  }
}

/**
 * Get payment by reference
 */
export async function getPaymentByReference(reference: string): Promise<any> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { reference },
      include: {
        land: true,
        cofO: true,
        user: true,
      },
    });
    return payment;
  } catch (error) {
    console.error("Error fetching payment:", error);
    return null;
  }
}

export async function verifyPaystackReference(
  reference: string,
): Promise<{ success: boolean; message: string; amount?: number; status?: string; raw?: any }> {
  try {
    const verify = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
      },
    );

    const paymentData = verify.data.data;
    if (!paymentData || paymentData.status !== "success") {
      return {
        success: false,
        message: "Paystack payment is not successful",
        raw: paymentData,
      };
    }

    return {
      success: true,
      message: "Payment verified successfully",
      amount: paymentData.amount / 100,
      status: paymentData.status,
      raw: paymentData,
    };
  } catch (error) {
    console.error("Error verifying Paystack reference:", error);
    return {
      success: false,
      message: "Unable to verify payment reference",
      raw: error,
    };
  }
}

/**
 * Get all payments for a user
 */
export async function getUserPayments(userId: string): Promise<any[]> {
  try {
    const payments = await prisma.payment.findMany({
      where: { userId },
      include: {
        land: true,
        cofO: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return payments;
  } catch (error) {
    console.error("Error fetching user payments:", error);
    return [];
  }
}

/**
 * Get payment by ID
 */
export async function getPaymentById(paymentId: string): Promise<any> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        land: true,
        cofO: true,
        user: true,
      },
    });
    return payment;
  } catch (error) {
    console.error("Error fetching payment by ID:", error);
    return null;
  }
}

/**
 * Confirm payment and update land/CofO status
 */
export async function confirmPayment(
  paymentId: string,
  paymentStatus: "SUCCESS" | "FAILED" | "UNPAID"
): Promise<{ success: boolean; message: string; data?: any }> {
  try {
    const payment = await getPaymentById(paymentId);

    if (!payment) {
      return {
        success: false,
        message: "Payment not found",
      };
    }

    // Update payment status
    const updatedPayment = await updatePaymentStatus(paymentId, paymentStatus);

    if (paymentStatus === "SUCCESS") {
      // If it's a land registration payment, update land status
      if (payment.type === "LAND_REGISTRATION" && payment.landId) {
        await prisma.landRegistration.update({
          where: { id: payment.landId },
          data: {
            landStatus: "PENDING", // Ready for reviewer verification
          },
        });
      }

      // If it's a CofO payment, update CofO status
      if (payment.type === "COFO" && payment.cofOId) {
        await prisma.cofOApplication.update({
          where: { id: payment.cofOId },
          data: {
            status: "PAYMENT_CONFIRMED",
          },
        });
      }

      return {
        success: true,
        message: "Payment confirmed successfully",
        data: updatedPayment,
      };
    }

    return {
      success: false,
      message: `Payment ${paymentStatus}`,
      data: updatedPayment,
    };
  } catch (error) {
    console.error("Error confirming payment:", error);
    return {
      success: false,
      message: "Error processing payment confirmation",
    };
  }
}

/**
 * Calculate land registration fee based on area
 */
export function calculateLandRegistrationFee(areaSqm: number): number {
  // Example pricing: NGN 5,000 base + NGN 10 per 100 m²
  const baseFee = 5000;
  const areaFee = (areaSqm / 100) * 10;
  return baseFee + areaFee;
}

/**
 * Calculate C of O fee
 */
export function calculateCofOFee(areaSqm: number): number {
  // Example pricing: NGN 10,000 base + NGN 20 per 100 m²
  const baseFee = 10000;
  const areaFee = (areaSqm / 100) * 20;
  return baseFee + areaFee;
}

/**
 * Check if land has pending payment
 */
export async function hasLandPendingPayment(landId: string): Promise<boolean> {
  try {
    const payment = await prisma.payment.findFirst({
      where: {
        landId,
        type: "LAND_REGISTRATION",
        status: "PENDING",
      },
    });
    return !!payment;
  } catch (error) {
    console.error("Error checking pending payment:", error);
    return false;
  }
}

/**
 * Get pending payment for land
 */
export async function getLandPendingPayment(landId: string): Promise<any> {
  try {
    const payment = await prisma.payment.findFirst({
      where: {
        landId,
        type: "LAND_REGISTRATION",
        status: "PENDING",
      },
    });
    return payment;
  } catch (error) {
    console.error("Error fetching pending payment:", error);
    return null;
  }
}
