import sgMail from "@sendgrid/mail";

export async function sendMail(to, subject, html) {
    // Resend: send with the verified domain from a server-only API key.
    if (process.env.RESEND_API_KEY) {
        const from = process.env.RESEND_FROM_EMAIL || process.env.MAIL_FROM;
        if (!from) throw new Error("Resend sender email is not configured");

        const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                from: `${process.env.MAIL_FROM_NAME || "AchieveTogether"} <${from}>`,
                to: [to],
                subject,
                html
            }),
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) {
            // Do not expose API keys, recipients, or email contents in errors.
            throw new Error(`Resend email request failed (HTTP ${response.status})`);
        }
        return;
    }

    // Free permanent transactional email provider (300 messages/day).
    if (process.env.BREVO_API_KEY) {
        const sender = process.env.BREVO_SENDER_EMAIL || process.env.MAIL_FROM;
        if (!sender) throw new Error("Brevo sender is not configured");

        const response = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "api-key": process.env.BREVO_API_KEY
            },
            body: JSON.stringify({
                sender: { name: process.env.MAIL_FROM_NAME || "AchieveTogether", email: sender },
                to: [{ email: to }],
                subject,
                htmlContent: html
            }),
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error(`Brevo email delivery failed (HTTP ${response.status})`);
        return;
    }

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
