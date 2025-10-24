import { Request, Response } from 'express';
import { PrismaClient, ApplicationStatus } from '../generated/prisma';

const prisma = new PrismaClient();

export const getAllApplications = async (_req: Request, res: Response) => {
  try {
    const applications = await prisma.application.findMany({
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(applications);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch applications', error: err });
  }
};

export const updateApplicationStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!Object.values(ApplicationStatus).includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  try {
    const updated = await prisma.application.update({
      where: { id },
      data: { status },
    });
    res.json({ message: 'Status updated', updated });
  } catch (err) {
    res.status(500).json({ message: 'Update failed', error: err });
  }
};
