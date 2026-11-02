# Email delivery — AchieveTogether

## Preferred: Brevo Free

The server uses the free [Brevo transactional email API](https://developers.brevo.com/reference/send-transac-email), with an ongoing **300 emails/day** quota. This does not depend on Google Gmail OAuth tokens.

### One-time account steps

1. Register or sign into https://app.brevo.com/ and complete account verification.
2. Under **Settings → Senders, Domains & Dedicated IPs → Senders**, create and **verify** the sender address. If using a Gmail/Yahoo sender, Brevo may replace the From address; a privately controlled domain with SPF, DKIM and DMARC is preferable.
3. Under **SMTP & API → API Keys**, create an API v3 key. **Never commit it**.
4. In the Render backend service, configure:
   - `BREVO_API_KEY` — the private API v3 key;
   - `BREVO_SENDER_EMAIL` — the sender address verified with Brevo (alternatively existing `MAIL_FROM`);
   - optional `MAIL_FROM_NAME` — defaults to AchieveTogether.
5. Redeploy the backend and verify registration email, 2FA and password reset reach a real inbox. Confirm Brevo transactional logs. Do **not** claim delivery works based on a successful build.

### How the code works

`services/sendmail.js`: Brevo first, otherwise existing SendGrid, otherwise existing Gmail OAuth. Errors from the selected provider are propagated, without silently falling back on failure. The Brevo request uses HTTPS, a 15-second timeout, and does not log keys or API response bodies. `routes/auth/password.js` recognizes Brevo as a configured sender. Registration and 2FA already use the shared mail function.

After successfully validating Brevo delivery, old Gmail/SendGrid credentials can be removed from Render. Until Brevo is configured, the existing provider still sends email (and a Gmail OAuth Testing token can still expire every seven days).

### Tests

`npm test` executes `tests/*.test.js` using Node's built-in test runner. The Brevo adapter test stubs network requests: it **does not send emails**.

### Why not SendGrid or Google Testing?

SendGrid ended the indefinite free email tier in 2025. New accounts have a 60-day trial, after which sending requires an upgrade. Google external OAuth apps in **Testing** status issue Gmail-scope refresh tokens that expire in seven days. Moving the consent screen to **In Production** removes that particular testing expiry, though tokens can still be revoked.

Official references:
- https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan
- https://developers.brevo.com/reference/send-transac-email
- https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email
- https://www.twilio.com/docs/sendgrid/ui/account-and-settings/upgrading-your-plan
- https://developers.google.com/identity/protocols/oauth2
