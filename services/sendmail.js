import sgMail from "@sendgrid/mail";

export async function sendMail(to, subject, html) {
    if (process.env.SENDGRID_API_KEY && process.env.MAIL_FROM) {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        await sgMail.send({
            to,
            from: process.env.MAIL_FROM,
            subject,
            html
        });
        return;
    }

    // Transitional fallback until the sender is configured in Render.
    if (!process.env.GOOGLE_REFRESH_TOKEN || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw new Error("Email delivery is not configured");
    }

    const { google } = await import("googleapis");
    const oauth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
    oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const gmail = google.gmail({ version: "v1", auth: oauth });
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
    const message = [
        `To: ${to}`,
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=UTF-8",
        `Subject: ${encodedSubject}`,
        "",
        html
    ].join("\r\n");

    await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: Buffer.from(message).toString("base64url") }
    });
}
