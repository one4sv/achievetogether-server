import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

export async function sendEmail(to, subject, html) {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,       // твой Gmail
        pass: process.env.EMAIL_PASS     // пароль приложения
      }
    });

    await transporter.sendMail({
      from: `"AchieveTogether" <${process.env.GMAIL_EMAIL}>`,
      to,
      subject,
      html
    });

    console.log("✅ Email sent to", to);
  } catch (err) {
    console.error("❌ Gmail SMTP error:", err);
  }
}
