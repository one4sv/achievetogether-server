import { randomUUID } from "node:crypto";
import { authenticateUser } from "../../middleware/token.js";
import { sendMail } from "../../services/sendmail.js";

const kinds = new Set(["bug", "idea", "other", "complaint", "report"]);
const targets = new Set(["account", "post", "message", "comment", "activity"]);
const reasons = new Set(["spam", "harassment", "hate", "violence", "sexual", "privacy", "fraud", "other"]);
const limits = new Map();

const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

const accept = (text, min, max) => typeof text === "string" &&
    text.trim().length >= min && text.trim().length <= max;

export const cleanUrl = value => {
    if (typeof value !== "string" || value.length > 500 || !value.startsWith("/") || value.startsWith("//")) return null;
    return value.split("#")[0].split("?")[0];
};

function allowRequest(key, authenticated) {
    const now = Date.now();
    for (const [id, entry] of limits) if (entry.until < now) limits.delete(id);
    const current = limits.get(key);
    if (current && current.count >= (authenticated ? 8 : 2)) return false;
    limits.set(key, { count: (current?.count || 0) + 1, until: current?.until || now + 3600000 });
    return true;
}

export function makeEmail({ id, kind, reason, title, details, target, sender, page, created }) {
    const label = { bug: "Ошибка", idea: "Предложение", other: "Обратная связь", complaint: "Жалоба", report: "Жалоба" }[kind];
    const accent = kind === "report" || kind === "complaint" ? "#ee777e" : "#f69c50";
    const reasonNames = { spam: "Спам", harassment: "Оскорбления и травля", hate: "Ненависть", violence: "Насилие или угрозы", sexual: "Неприемлемый контент", privacy: "Нарушение приватности", fraud: "Мошенничество", other: "Другое" };
    const item = (name, value) => `<tr><td style="padding:12px 16px;color:#9ca0af;border-bottom:1px solid #292a34;vertical-align:top;width:140px;">${escapeHTML(name)}</td><td style="padding:12px 16px;color:#f1f2f7;border-bottom:1px solid #292a34;word-break:break-word;">${escapeHTML(value || "—")}</td></tr>`;
    return `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:32px 14px;background:#101116;font-family:Arial,sans-serif;color:#f1f2f7">
<div style="max-width:620px;margin:auto;border:1px solid #373942;border-radius:24px;background:#1b1c23;overflow:hidden">
<div style="padding:30px;background:linear-gradient(125deg,#31261f,#252631);border-bottom:1px solid #373942">
<div style="font-size:13px;letter-spacing:2px;color:${accent};text-transform:uppercase">AchieveTogether · Feedback</div>
<div style="margin-top:14px;font-size:30px;color:#fff">${escapeHTML(label)}</div>
<div style="margin-top:7px;color:#b5b7c3">Обращение № ${escapeHTML(id)}</div>
</div>
<div style="padding:24px 18px">
<div style="font-size:21px;margin:0 0 14px;color:#fff">${escapeHTML(title)}</div>
<table style="width:100%;border-collapse:collapse;font-size:14px">${item("Тип",label)}${item("Причина",reasonNames[reason] || reason)}${item("Объект",target)}${item("Автор",sender)}${item("Страница",page)}${item("Дата",created)}</table>
<div style="margin-top:20px;border-radius:16px;padding:18px;background:#25262f;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55">${escapeHTML(details)}</div>
</div>
<div style="padding:16px 24px;border-top:1px solid #373942;color:#9699a6;font-size:12px">Сообщение отправлено из AT. Личные сообщения и файлы не прикладываются автоматически. Проверяйте права доступа перед открытием объекта.</div>
</div></body></html>`;
}

export default function feedbackRoutes(app, supabase) {
    app.post("/feedback", authenticateUser(supabase), async (req, res) => {
        const origin = req.get("origin");
        const allowed = (process.env.CLIENT_URL || "https://achievetogether.vercel.app").split(",").map(item => item.trim());
        if (!origin || !allowed.includes(origin)) return res.status(403).json({ success: false, error: "Origin rejected" });
        const body = req.body || {};
        // Do not disclose the honeypot to automated clients.
        if (body.website) return res.json({ success: true });
        const { kind, targetType, targetId, reason, title, details, contactEmail } = body;
        const isReport = kind === "report";
        if (!kinds.has(kind) || !accept(title, 4, 140) || !accept(details, 12, 3000) ||
            (isReport && (!req.user?.id || !targets.has(targetType) || typeof targetId !== "string" || !/^[A-Za-z0-9_:-]{1,120}$/.test(targetId) || !reasons.has(reason))) ||
            (!isReport && (targetType || targetId || (kind !== "complaint" && reason))) ||
            (kind === "complaint" && !reasons.has(reason)) ||
            (contactEmail != null && contactEmail !== "" &&
                (typeof contactEmail !== "string" || contactEmail.length > 140 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)))) {
            return res.status(400).json({ success: false, error: "Invalid feedback" });
        }
        const key = req.user?.id ? "user:" + req.user.id : "guest:" + req.ip;
        if (!allowRequest(key, !!req.user?.id)) {
            res.set("Retry-After", "3600");
            return res.status(429).json({ success: false, error: "Too many requests" });
        }
        const id = randomUUID().slice(0, 8).toUpperCase();
        const page = cleanUrl(body.page);
        const target = isReport ? targetType + ":" + targetId : "";
        let sender = req.user?.id ? "User " + req.user.id : "Guest";
        if (req.user?.id) {
            const { data } = await supabase.from("users").select("nick,mail").eq("id", req.user.id).maybeSingle();
            if (data) sender = (data.nick || sender) + " · " + (data.mail || "");
        } else if (contactEmail) sender += " · " + contactEmail;
        try {
            await sendMail(
                process.env.SUPPORT_EMAIL || "kutenko18@gmail.com",
                `[AT] ${isReport || kind === "complaint" ? "Жалоба" : "Обратная связь"} #${id}`,
                makeEmail({ id, kind, reason: (isReport || kind === "complaint") ? reason : "", title: title.trim(), details: details.trim(), target, sender, page, created: new Date().toISOString() })
            );
            res.json({ success: true, id });
        } catch (error) {
            console.error("Feedback delivery failed:", error.message);
            res.status(503).json({ success: false, error: "Feedback delivery unavailable" });
        }
    });
}
