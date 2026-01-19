import prisma from "../lib/prisma";
import { Request, Response } from "express";
import { AuthRequest } from "../middlewares/authMiddleware";


export const getUserDashboardOverview = async (
  req: AuthRequest,
  res: Response
) => {
  const userId = req.user.sub;

  try {
    const [
      totalLands,
      totalApplications,
      approvedCofO,
      pendingCofO,
      rejectedCofO,
      recentApplications,
      recentPayments,
    ] = await Promise.all([
      prisma.landRegistration.count({ where: { ownerId: userId } }),

      prisma.cofOApplication.count({ where: { userId } }),

      prisma.cofOApplication.count({
        where: { userId, status: "APPROVED" },
      }),

      prisma.cofOApplication.count({
        where: { userId, status: "DRAFT" },
      }),

      prisma.cofOApplication.count({
        where: { userId, status: "NEEDS_CORRECTION" },
      }),

      prisma.cofOApplication.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: {
          land: true,
          payments: {
            select: { status: true },
          },
        },
      }),

      prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);

    res.json({
      stats: {
        totalLands,
        totalApplications,
        approvedCofO,
        pendingCofO,
        rejectedCofO,
      },
      recentApplications: recentApplications.map((app) => ({
        id: app.id,
        status: app.status,
        submittedAt: app.createdAt,
        paymentStatus: app.payments?.[0]?.status ?? "UNPAID",
      })),
      recentPayments: recentPayments.map((p) => ({
        reference: p.reference,
        amount: p.amount,
        status: p.status,
        date: p.createdAt,
      })),
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to load dashboard data",
    });
  }
};