import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

// OAuth2 клиент для Gmail API
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

oAuth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

// Функция отправки письма
export async function sendEmail(to, subject, html) {
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  const message = [
    `To: ${to}`,
    "Content-Type: text/html; charset=UTF-8",
    `Subject: ${subject}`,
    "",
    html
  ].join("\n");

  const encodedMessage = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encodedMessage }
    });
    console.log("✅ Email sent to", to);
  } catch (err) {
    console.error("❌ Gmail API error:", err);
  }
}
