import sgMail from "@sendgrid/mail";

const from = () => process.env.MAIL_FROM;
const key = () => process.env.SENDGRID_API_KEY;

export async function sendMail(to, subject, html) {
    if (!key() || !from()) {
        throw new Error("Email delivery is not configured: SENDGRID_API_KEY and MAIL_FROM are required");
    }

    sgMail.setApiKey(key());
    await sgMail.send({
        to,
        from: from(),
        subject,
        html
    });
}
