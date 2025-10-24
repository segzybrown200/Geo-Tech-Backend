import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const CLIENT_ID = process.env.GOOGLE_ID!;
const CLIENT_SECRET = process.env.GOOGLE_SECRET!;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESHTOKEN!;
const REDIRECT_URI = "https://developers.google.com/oauthplayground";

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

export const sendEmail = async (to: string, subject: string, html: string) => {
  try {
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

    const messageParts = [
      `To: ${to}`,
      "Content-Type: text/html; charset=utf-8",
      "MIME-Version: 1.0",
      `Subject: ${subject}`,
      "",
      html,
    ];
    const message = messageParts.join("\n");

    const encodedMessage = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encodedMessage },
      
    });

    console.log("✅ Gmail API: email sent successfully!");
  } catch (err) {
    console.error("❌ Failed to send via Gmail API:", err);
  }
};
