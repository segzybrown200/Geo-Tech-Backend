import PDFDocument from "pdfkit";
import { Readable } from "stream";
import { uploadToCloudinary } from "../services/uploadService";

interface CofOData {
  applicationNumber: string;
  cofONumber?: string | null;
  user: {
    fullName: string;
    email: string;
    phone?: string;
  };
  land: {
    address: string;
    plotNumber: string | null;
    state: {
      name: string;
    };
    squareMeters: number;
    ownershipType: string;
    purpose: string;
    latitude?: number;
    longitude?: number;
  };
  signedAt?: Date;
  governorSignatureUrl?: string;
  approvedBy?: {
    name: string;
    position: string;
  };
}

export async function generateCofOCertificate(cofO: CofOData): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const buffers: Buffer[] = [];

      // Collect PDF data
      doc.on("data", (chunk: Buffer) => buffers.push(chunk));
      doc.on("end", async () => {
        try {
          const pdfBuffer = Buffer.concat(buffers);
          
          // Upload PDF using centralized upload service
          const baseId = (cofO.cofONumber ?? cofO.applicationNumber ?? "UNKNOWN")
            .toString()
            .replace(/^COFO-/, "");
          const filename = `COFO-${baseId}-${Date.now()}.pdf`;
          try {
            const result = await uploadToCloudinary(pdfBuffer, filename, "application/pdf", {
              folder: "geotech_certificates",
              resourceType: "raw",
            });

            if (result && result.secure_url) {
              resolve(result.secure_url);
            } else {
              reject(new Error("Cloudinary upload did not return secure_url"));
            }
          } catch (err) {
            reject(err);
          }
        } catch (error) {
          reject(error);
        }
      });

      doc.on("error", reject);

      // ============ HEADER - GOVERNMENT COAT OF ARMS ============
      doc.fontSize(10).text("FEDERAL REPUBLIC OF NIGERIA", { align: "center" });
      doc.fontSize(9).text("Office of the State Governor", { align: "center" });
      doc.fontSize(9).text(cofO.land.state.name.toUpperCase(), { align: "center" });
      
      doc.moveTo(40, 80).lineTo(555, 80).stroke();
      doc.moveDown(0.5);

      // ============ TITLE ============
      doc.fontSize(16)
        .font("Helvetica-Bold")
        .text("CERTIFICATE OF OCCUPANCY", { align: "center" });
      doc.moveDown(0.2);
      
      doc.fontSize(11)
        .font("Helvetica")
        .text(`Issued under the Land Use Act (Cap. L5, Laws of the Federation of Nigeria, 1990)`, {
          align: "center",
        });
      
      doc.moveTo(40, 130).lineTo(555, 130).stroke();
      doc.moveDown();

      // ============ CERTIFICATE NUMBER & DATE ============
      doc.fontSize(10).font("Helvetica-Bold");
      doc.text(`Certificate No: ${cofO.cofONumber || cofO.applicationNumber}`, {
        align: "right",
      });
      doc.text(
        `Date of Issue: ${cofO.signedAt ? new Date(cofO.signedAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        }) : new Date().toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })}`,
        { align: "right" }
      );

      doc.moveDown();

      // ============ CERTIFICATE BODY ============
      doc.fontSize(11).font("Helvetica");

      doc.text("TO WHOM IT MAY CONCERN:", { underline: true });
      doc.moveDown();

      doc.fontSize(10).text(
        `This is to certify that under the authority vested in the Governor of ${cofO.land.state.name} by Section 31(1) of the Land Use Act, Cap. L5, Laws of the Federation of Nigeria, 1990, and based on the complete documentation provided, the Certificate of Occupancy is hereby granted to:`,
        { align: "justify" }
      );

      doc.moveDown();

      // ============ HOLDER DETAILS ============
      doc.fontSize(10).font("Helvetica-Bold");
      doc.text("APPLICANT DETAILS");
      doc.moveDown(0.3);

      doc.fontSize(9).font("Helvetica");
      doc.text(`Full Name: ${cofO.user.fullName}`, { indent: 20 });
      doc.text(`Email Address: ${cofO.user.email}`, { indent: 20 });
      if (cofO.user.phone) {
        doc.text(`Phone Number: ${cofO.user.phone}`, { indent: 20 });
      }

      doc.moveDown();

      // ============ LAND DETAILS ============
      doc.fontSize(10).font("Helvetica-Bold");
      doc.text("PROPERTY DETAILS");
      doc.moveDown(0.3);

      doc.fontSize(9).font("Helvetica");
      doc.text(`Location/Address: ${cofO.land.address}`, { indent: 20 });
      doc.text(`State: ${cofO.land.state.name}`, { indent: 20 });
      doc.text(`Plot Number: ${cofO.land.plotNumber || "N/A"}`, { indent: 20 });
      doc.text(`Land Area: ${cofO.land.squareMeters.toLocaleString()} square meters`, {
        indent: 20,
      });
      
      if (cofO.land.latitude && cofO.land.longitude) {
        doc.text(
          `Coordinates: ${cofO.land.latitude.toFixed(6)}, ${cofO.land.longitude.toFixed(6)}`,
          { indent: 20 }
        );
      }

      doc.text(`Ownership Type: ${cofO.land.ownershipType}`, { indent: 20 });
      doc.text(`Purpose of Land: ${cofO.land.purpose}`, { indent: 20 });

      doc.moveDown();

      // ============ CERTIFICATE CONDITIONS ============
      doc.fontSize(10).font("Helvetica-Bold");
      doc.text("TERMS AND CONDITIONS");
      doc.moveDown(0.3);

      doc.fontSize(9).font("Helvetica");
      const conditions = [
        "This Certificate of Occupancy is granted for a period of Ninety-Nine (99) years from the date of issue.",
        "The holder shall use the land in accordance with the purposes stated herein and shall not engage in any activity that contravenes the land use plan or applicable laws.",
        "The holder is responsible for the payment of all statutory dues and taxes as prescribed by the State Government.",
        "This Certificate is non-transferable without the consent of the Governor, and any transfer shall be subject to applicable fees.",
        "The State Government reserves the right to recover the land for public purposes on payment of compensation in accordance with law.",
        "The holder shall maintain the property in good condition and prevent its abandonment.",
      ];

      conditions.forEach((condition, index) => {
        doc.text(`${index + 1}. ${condition}`, { indent: 20, align: "justify" });
        doc.moveDown(0.3);
      });

      doc.moveDown();

      // ============ SIGNATURE & SEAL SECTION ============
      doc.fontSize(9).font("Helvetica-Bold");
      doc.text("IN WITNESS WHEREOF, the Governor of " + cofO.land.state.name + " has caused this Certificate to be issued.", {
        align: "justify",
      });

      doc.moveDown(2);

      if (cofO.governorSignatureUrl) {
        try {
          doc.image(cofO.governorSignatureUrl, 60, doc.y, { width: 80 });
        } catch (e) {
          doc.fontSize(9).text("[Governor Signature]");
        }
      } else {
        doc.fontSize(9).text("[Governor Signature]");
      }

      doc.moveTo(40, doc.y + 40).lineTo(140, doc.y + 40).stroke();
      doc.moveDown(2.5);
      doc.fontSize(9).font("Helvetica-Bold").text("Governor", { width: 100 });

      doc.moveDown(1);

      doc.fontSize(8).font("Helvetica");
      if (cofO.approvedBy) {
        doc.text(`Approved by: ${cofO.approvedBy.name}`);
        doc.text(`Position: ${cofO.approvedBy.position}`);
      }

      // ============ FOOTER ============
      doc.moveTo(40, 750).lineTo(555, 750).stroke();
      doc.moveDown(0.3);
      doc.fontSize(8).font("Helvetica").text(
        `Certificate No: ${cofO.cofONumber || cofO.applicationNumber} | Application No: ${cofO.applicationNumber} | Issued: ${new Date().getFullYear()}`,
        { align: "center" }
      );

      // Finalize PDF
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
