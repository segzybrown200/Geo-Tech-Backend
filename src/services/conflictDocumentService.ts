import prisma from "../lib/prisma";

export interface ConflictDetails {
  newLandId: string;
  conflictingLandId: string;
}

export interface ConflictDocumentData {
  newLandOwner: {
    id: string;
    fullName: string;
    email: string;
    phone?: string;
  };
  newLand: {
    id: string;
    ownerName: string;
    areaSqm: number | null;
    purpose: string;
    titleType: string;
    ownershipType: string;
    address?: string;
  };
  conflictingLandOwner: {
    id: string;
    fullName: string;
    email: string;
    phone?: string;
  };
  conflictingLand: {
    id: string;
    ownerName: string;
    areaSqm: number | null;
    purpose: string;
    titleType: string;
    ownershipType: string;
    address?: string;
  };
  overlapPercentage?: number;
  conflictType: "OVERLAP" | "EXISTING_COFO";
  timestamp: Date;
}

/**
 * Generate conflict document data for a land conflict
 */
export async function generateConflictDocumentData(
  newLandId: string,
  conflictingLandId: string,
  conflictType: "OVERLAP" | "EXISTING_COFO" = "OVERLAP"
): Promise<ConflictDocumentData | null> {
  try {
    // Fetch new land and owner
    const newLand = await prisma.landRegistration.findUnique({
      where: { id: newLandId },
      include: {
        owner: true,
      },
    });

    if (!newLand) {
      return null;
    }

    // Fetch conflicting land and owner
    const conflictingLand = await prisma.landRegistration.findUnique({
      where: { id: conflictingLandId },
      include: {
        owner: true,
      },
    });

    if (!conflictingLand) {
      return null;
    }

    return {
      newLandOwner: {
        id: newLand.ownerId,
        fullName: newLand.owner.fullName || "Unknown",
        email: newLand.owner.email,
        phone: newLand.owner.phone ?? undefined,
      },
      newLand: {
        id: newLand.id,
        ownerName: newLand.ownerName,
        areaSqm: newLand.areaSqm,
        purpose: newLand.purpose,
        titleType: newLand.titleType,
        ownershipType: newLand.ownershipType,
        address: newLand.address ?? undefined,
      },
      conflictingLandOwner: {
        id: conflictingLand.ownerId,
        fullName: conflictingLand.owner.fullName || "Unknown",
        email: conflictingLand.owner.email,
        phone: conflictingLand.owner.phone ?? undefined,
      },
      conflictingLand: {
        id: conflictingLand.id,
        ownerName: conflictingLand.ownerName,
        areaSqm: conflictingLand.areaSqm,
        purpose: conflictingLand.purpose,
        titleType: conflictingLand.titleType,
        ownershipType: conflictingLand.ownershipType,
        address: conflictingLand.address ?? undefined,
      },
      conflictType,
      timestamp: new Date(),
    };
  } catch (error) {
    console.error("Error generating conflict document data:", error);
    return null;
  }
}

/**
 * Generate a text-based conflict document
 */
export function generateConflictDocumentText(
  data: ConflictDocumentData
): string {
  const separator = "=".repeat(80);
  const timestamp = data.timestamp.toISOString().split("T")[0];

  let document = `
${separator}
LAND CONFLICT NOTIFICATION DOCUMENT
${separator}

Document Generated: ${timestamp}
Document Type: Land Conflict Notice

${separator}
1. CONFLICT INFORMATION
${separator}

Conflict Type: ${data.conflictType === "OVERLAP" ? "Land Overlap" : "Existing Certificate of Occupancy"}
Status: FLAGGED FOR REVIEW
Severity: HIGH

This document notifies you that the land you are attempting to register overlaps with 
or conflicts with an existing land registration in the system.

${separator}
2. YOUR LAND DETAILS
${separator}

Land ID: ${data.newLand.id}
Owner Name: ${data.newLand.ownerName}
Ownership Type: ${data.newLand.ownershipType}
Purpose: ${data.newLand.purpose}
Title Type: ${data.newLand.titleType}
Area (m²): ${data.newLand.areaSqm?.toFixed(2) || "Not Specified"}
Address: ${data.newLand.address || "Not Provided"}

Your Contact Information:
Name: ${data.newLandOwner.fullName}
Email: ${data.newLandOwner.email}
Phone: ${data.newLandOwner.phone || "Not Provided"}

${separator}
3. CONFLICTING LAND DETAILS
${separator}

Land ID: ${data.conflictingLand.id}
Owner Name: ${data.conflictingLand.ownerName}
Ownership Type: ${data.conflictingLand.ownershipType}
Purpose: ${data.conflictingLand.purpose}
Title Type: ${data.conflictingLand.titleType}
Area (m²): ${data.conflictingLand.areaSqm?.toFixed(2) || "Not Specified"}
Address: ${data.conflictingLand.address || "Not Provided"}

Existing Owner Contact Information:
Name: ${data.conflictingLandOwner.fullName}
Email: ${data.conflictingLandOwner.email}
Phone: ${data.conflictingLandOwner.phone || "Not Provided"}

${separator}
4. REQUIRED ACTIONS
${separator}

Before your land registration can proceed, you MUST:

1. Review the details of the conflicting land above
2. Contact the existing land owner to:
   - Clarify the boundary differences
   - Resolve the overlap through agreement
   - Obtain written consent if applicable
3. Acknowledge this conflict in the system by submitting the acknowledgment form
4. Proceed with payment for land registration
5. Submit your land registration for reviewer verification

The existing land owner has been notified of this potential conflict through a separate notice.

${separator}
5. LEGAL NOTICES
${separator}

IMPORTANT: Registering land that overlaps with another property without resolution 
may result in:
- Rejection of your application
- Legal disputes with the existing owner
- Property rights conflicts

You are responsible for ensuring all boundary information is accurate and does not 
conflict with existing registered properties.

${separator}
6. ACKNOWLEDGMENT
${separator}

By proceeding with this land registration, you acknowledge that:
✓ You have reviewed the conflicting land details above
✓ You are aware of the land overlap/conflict
✓ You will work to resolve this conflict
✓ All information provided is accurate and truthful

${separator}

This document is generated automatically by the Land Registration System.
For disputes or clarifications, contact the appropriate land administration authority.

Generated on: ${new Date().toLocaleString()}

${separator}
`;

  return document;
}

/**
 * Create a conflict record in the database
 */
export async function createConflictRecord(
  newLandId: string,
  conflictingLandId: string,
  conflictType: "OVERLAP" | "EXISTING_COFO",
  documentUrl?: string
): Promise<any> {
  try {
    const conflict = await prisma.landConflict.create({
      data: {
        landId: newLandId,
        conflictingLandId: conflictingLandId,
        conflictType,
        status: "FLAGGED",
        conflictDocument: documentUrl,
      },
    });
    return conflict;
  } catch (error) {
    console.error("Error creating conflict record:", error);
    throw error;
  }
}

/**
 * Check if a conflict exists between two lands
 */
export async function checkConflictExists(
  landId1: string,
  landId2: string
): Promise<any | null> {
  try {
    const conflict = await prisma.landConflict.findFirst({
      where: {
        OR: [
          {
            landId: landId1,
            conflictingLandId: landId2,
          },
          {
            landId: landId2,
            conflictingLandId: landId1,
          },
        ],
      },
    });
    return conflict;
  } catch (error) {
    console.error("Error checking conflict:", error);
    return null;
  }
}

/**
 * Update conflict status
 */
export async function updateConflictStatus(
  conflictId: string,
  status: "FLAGGED" | "ACKNOWLEDGED" | "RESOLVED"
): Promise<any> {
  try {
    const updatedConflict = await prisma.landConflict.update({
      where: { id: conflictId },
      data: { status },
    });
    return updatedConflict;
  } catch (error) {
    console.error("Error updating conflict status:", error);
    throw error;
  }
}

/**
 * Get all conflicts for a land
 */
export async function getConflictsForLand(landId: string): Promise<any[]> {
  try {
    const conflicts = await prisma.landConflict.findMany({
      where: {
        OR: [{ landId }, { conflictingLandId: landId }],
      },
      include: {
        land: {
          include: { owner: true },
        },
        conflictingLand: {
          include: { owner: true },
        },
      },
    });
    return conflicts;
  } catch (error) {
    console.error("Error fetching conflicts:", error);
    return [];
  }
}
