import PDFDocument from "pdfkit";
import { Readable } from "stream";
import axios from "axios";
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
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const buffers: Buffer[] = [];

      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", async () => {
        const pdfBuffer = Buffer.concat(buffers);

        const filename = `COFO-${Date.now()}.pdf`;

        const result = await uploadToCloudinary(
          pdfBuffer,
          filename,
          "application/pdf",
          { folder: "geotech_certificates", resourceType: "raw" }
        );

        resolve(result.secure_url);
      });

      const WIDTH = doc.page.width - 100;

      // ================= HEADER =================
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("FEDERAL REPUBLIC OF NIGERIA", { align: "center" });

      doc
        .fontSize(10)
        .text(`GOVERNMENT OF ${cofO.land.state.name.toUpperCase()} STATE`, { align: "center" });

      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();

      doc.moveDown();

      // ================= TITLE =================
      doc
        .fontSize(18)
        .font("Helvetica-Bold")
        .text("CERTIFICATE OF OCCUPANCY", { align: "center" });

      doc
        .moveDown(0.5)
        .fontSize(10)
        .font("Helvetica")
        .text(
          "Issued pursuant to the Land Use Act, Cap L5 Laws of the Federation of Nigeria 2004",
          { align: "center", width: WIDTH }
        );

      doc.moveDown();

      // ================= META =================
      doc.font("Helvetica-Bold").fontSize(10);
      doc.text(`Certificate No: ${cofO.cofONumber}`, { align: "right" });
      doc.text(`Date: ${new Date().toDateString()}`, { align: "right" });

      doc.moveDown(1.5);

      // ================= BODY =================
      doc.font("Helvetica").fontSize(11);

      doc.text(
        `This is to certify that the Governor of ${cofO.land.state.name} State hereby grants a Right of Occupancy over the land described below to:`,
        { width: WIDTH, align: "justify" }
      );

      doc.moveDown();

      // ================= APPLICANT =================
      section(doc, "GRANTEE DETAILS");

      info(doc, "Name", cofO.user.fullName);
      info(doc, "Email", cofO.user.email);
      if (cofO.user.phone) info(doc, "Phone", cofO.user.phone);

      doc.moveDown();

      // ================= LAND =================
      section(doc, "LAND DESCRIPTION");

      info(doc, "Address", cofO.land.address);
      info(doc, "Plot Number", cofO.land.plotNumber ?? "N/A");
      info(doc, "Area", `${cofO.land.squareMeters} sqm`);
      info(doc, "Purpose", cofO.land.purpose);

      if (cofO.land.latitude && cofO.land.longitude) {
        info(doc, "Coordinates", `${cofO.land.latitude}, ${cofO.land.longitude}`);
      }

      doc.moveDown();

      // ================= TERMS =================
      section(doc, "CONDITIONS");

      const terms = [
        "Tenure of 99 years from date of issue.",
        "Land shall be used only for approved purpose.",
        "No transfer without Governor’s consent.",
        "Government reserves right of revocation.",
      ];

      terms.forEach((t, i) => {
        doc.text(`${i + 1}. ${t}`, { width: WIDTH });
        doc.moveDown(0.3);
      });

      doc.moveDown(2);

      // ================= SIGNATURE =================
      doc.text(
        `Given under my hand this ${new Date().toDateString()}`,
        { width: WIDTH }
      );

      doc.moveDown(2);

      if (cofO.governorSignatureUrl) {
        const res = await axios.get(cofO.governorSignatureUrl, {
          responseType: "arraybuffer",
        });

        doc.image(res.data, doc.x, doc.y, { width: 120 });
      }

      doc.moveDown(3);

      doc.font("Helvetica-Bold").text("GOVERNOR", { align: "left" });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ============ helpers ============

function section(doc: PDFKit.PDFDocument, title: string) {
  doc.font("Helvetica-Bold").fontSize(12).text(title);
  doc.moveDown(0.3);
}

function info(doc: PDFKit.PDFDocument, label: string, value: string) {
  doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
  doc.font("Helvetica").text(value);
}

