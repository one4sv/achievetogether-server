import sgMail from "@sendgrid/mail";
import dotenv from "dotenv";
dotenv.config();

sgMail.setApiKey(process.env.API_SENDGRID);

export async function sendEmail(to, subject, html) {
  try {
    await sgMail.send({
      to,
      from: "no-reply@achievetogether.com",
      subject,
      html
    });
    console.log("✅ Email sent to", to);
  } catch (err) {
    console.error("❌ SendGrid API error:", err);
  }
}
