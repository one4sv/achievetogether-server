import { createHash, randomBytes, randomInt } from "node:crypto";
import jwt from "jsonwebtoken";
import { authenticateUser } from "../../middleware/token.js";
const hash = value => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const valid = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const now = () => new Date().toISOString();
const duration = 30 * 24 * 60 * 60 * 1000;
const cookieOptions = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV !== "test",
    sameSite: process.env.NODE_ENV === "test" ? "lax" : "none",
    path: "/"
});
const session = (res, id) => res.cookie(
    "token",
    jwt.sign({
        id
    }, process.env.JWT_SECRET, {
        expiresIn: "30d"
    }),
    {
        ...cookieOptions(),
        maxAge: duration
    }
);
export default function deviceRoutes(app, supabase) {
    const attempts = new Map();
    const guard = (req, res, next) => {
        res.set("Cache-Control", "no-store");
        const allowed = (process.env.CLIENT_URL || "https://achievetogether.vercel.app").split(",").map(s => s.trim());
        if (process.env.NODE_ENV !== "production") allowed.push("http://localhost:5173", "http://127.0.0.1:5173");
        if (req.method !== "GET" && !allowed.includes(req.get("origin"))) return res.status(403).json(
            {
                success: false,
                error: "Недопустимый источник запроса"
            }
        );
        const time = Date.now();
        for (const [key, entry] of attempts) if (entry.until < time) attempts.delete(key);
        const key = `${req.ip}:${req.path}`;
        const entry = attempts.get(key) || {
            count: 0,
            until: time + 60000
        };
        if (attempts.size > 10000 || ++entry.count > (req.method === "GET" ? 90 : 20)) return res.status(429).json(
            {
                success: false,
                error: "Слишком много попыток. Подождите минуту."
            }
        );
        attempts.set(key, entry);
        next();
    };
    const wrap = fn => async (req, res, next) => {
        try {
            await fn(req, res);
        } catch (error) {
            next(error);
        }
    };
    const checked = async query => {
        const result = await query;
        if (result.error) throw result.error;
        return result.data;
    };
    const auth = authenticateUser(supabase);
    app.post(
        "/auth/qr",
        guard,
        wrap(
            async (req, res) => {
                await checked(supabase.from("at_qr_logins").delete().lt("expires_at", now()));
                const claim = secret(),
                    browser = secret();
                const row = await checked(
                    supabase.from("at_qr_logins").insert(
                        {
                            claim_hash: hash(claim),
                            browser_hash: hash(browser),
                            label: (req.get("user-agent") || "Браузер").slice(0, 180),
                            code: String(randomInt(100000, 1000000)),
                            expires_at: new Date(Date.now() + 120000).toISOString()
                        }
                    ).select(
                        "id,code,expires_at"
                    ).single()
                );
                res.cookie(
                    `at_qr_${row.id}`,
                    browser,
                    {
                        ...cookieOptions(),
                        maxAge: 120000
                    }
                );
                res.json(
                    {
                        success: true,
                        ...row,
                        claim
                    }
                );
            }
        )
    );
    app.get(
        "/auth/qr/:id",
        guard,
        wrap(
            async (req, res) => {
                if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({
                    success: false
                });
                const browser = req.cookies[`at_qr_${req.params.id}`];
                if (!valid(browser)) return res.status(410).json({
                    success: false
                });
                const row = await checked(
                    supabase.from("at_qr_logins").select("user_id").eq("id", req.params.id).eq(
                        "browser_hash",
                        hash(browser)
                    ).gt(
                        "expires_at",
                        now()
                    ).maybeSingle()
                );
                if (!row) return res.status(410).json({
                    success: false
                });
                res.json(
                    {
                        success: true,
                        approved: !!row.user_id
                    }
                );
            }
        )
    );
    app.post(
        "/auth/qr/inspect",
        guard,
        auth,
        wrap(
            async (req, res) => {
                if (!req.user?.id) return res.status(401).json({
                    success: false
                });
                if (!valid(req.body.claim)) return res.status(400).json({
                    success: false
                });
                const row = await checked(
                    supabase.from("at_qr_logins").select("label,code,expires_at").eq("claim_hash", hash(req.body.claim)).is(
                        "user_id",
                        null
                    ).gt(
                        "expires_at",
                        now()
                    ).maybeSingle()
                );
                if (!row) return res.status(410).json({
                    success: false
                });
                res.json({
                    success: true,
                    ...row
                });
            }
        )
    );
    app.post(
        "/auth/qr/approve",
        guard,
        auth,
        wrap(
            async (req, res) => {
                if (!req.user?.id) return res.status(401).json({
                    success: false
                });
                if (!valid(req.body.claim)) return res.status(400).json({
                    success: false
                });
                const user = await checked(supabase.from("users").select("id").eq("id", req.user.id).maybeSingle());
                if (!user) return res.status(401).json({
                    success: false
                });
                const rows = await checked(
                    supabase.from("at_qr_logins").update(
                        {
                            user_id: user.id
                        }
                    ).eq(
                        "claim_hash",
                        hash(req.body.claim)
                    ).eq(
                        "code",
                        String(req.body.code)
                    ).is(
                        "user_id",
                        null
                    ).gt(
                        "expires_at",
                        now()
                    ).select(
                        "id"
                    )
                );
                if (!rows?.length) return res.status(410).json({
                    success: false
                });
                res.json({
                    success: true
                });
            }
        )
    );
    app.post(
        "/auth/qr/consume",
        guard,
        wrap(
            async (req, res) => {
                if (typeof req.body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(req.body.id)) return res.status(400).json({
                    success: false
                });
                const browser = req.cookies[`at_qr_${req.body.id}`];
                if (!valid(browser)) return res.status(410).json({
                    success: false
                });
                // DELETE RETURNING consumes the challenge atomically, including across replicas.
                const rows = await checked(
                    supabase.from("at_qr_logins").delete().eq("id", req.body.id).eq("browser_hash", hash(browser)).not(
                        "user_id",
                        "is",
                        null
                    ).gt(
                        "expires_at",
                        now()
                    ).select(
                        "user_id"
                    )
                );
                if (!rows?.length) return res.status(410).json({
                    success: false
                });
                session(res, rows[0].user_id);
                res.clearCookie(`at_qr_${req.body.id}`, cookieOptions());
                res.json({
                    success: true
                });
            }
        )
    );
    app.post(
        "/auth/device",
        guard,
        auth,
        wrap(
            async (req, res) => {
                if (!req.user?.id) return res.status(401).json({
                    success: false
                });
                const token = secret();
                const old = req.cookies.at_device;
                if (valid(old)) await checked(supabase.from("at_trusted_devices").delete().eq("token_hash", hash(old)));
                await checked(supabase.from("at_trusted_devices").delete().lt("expires_at", now()));
                await checked(
                    supabase.from("at_trusted_devices").insert(
                        {
                            user_id: req.user.id,
                            token_hash: hash(token),
                            expires_at: new Date(Date.now() + duration).toISOString()
                        }
                    )
                );
                res.cookie(
                    "at_device",
                    token,
                    {
                        ...cookieOptions(),
                        maxAge: duration
                    }
                );
                res.json({
                    success: true
                });
            }
        )
    );
    app.get(
        "/auth/device",
        guard,
        wrap(
            async (req, res) => {
                const token = req.cookies.at_device;
                if (!valid(token)) return res.json({
                    success: true,
                    account: null
                });
                const device = await checked(
                    supabase.from("at_trusted_devices").select("user_id").eq("token_hash", hash(token)).gt(
                        "expires_at",
                        now()
                    ).maybeSingle()
                );
                const account = device ? await checked(supabase.from("users").select("nick,username").eq("id", device.user_id).maybeSingle()) : null;
                res.json({
                    success: true,
                    account
                });
            }
        )
    );
    app.post(
        "/auth/device/login",
        guard,
        wrap(
            async (req, res) => {
                const old = req.cookies.at_device;
                if (!valid(old)) return res.status(401).json({
                    success: false
                });
                const token = secret();
                const rows = await checked(
                    supabase.from("at_trusted_devices").update(
                        {
                            token_hash: hash(token)
                        }
                    ).eq(
                        "token_hash",
                        hash(old)
                    ).gt(
                        "expires_at",
                        now()
                    ).select(
                        "user_id,expires_at"
                    )
                );
                if (!rows?.length) return res.status(401).json({
                    success: false
                });
                session(res, rows[0].user_id);
                res.cookie(
                    "at_device",
                    token,
                    {
                        ...cookieOptions(),
                        expires: new Date(rows[0].expires_at)
                    }
                );
                res.json({
                    success: true
                });
            }
        )
    );
    app.delete(
        "/auth/device",
        guard,
        wrap(
            async (req, res) => {
                const token = req.cookies.at_device;
                if (valid(token)) await checked(supabase.from("at_trusted_devices").delete().eq("token_hash", hash(token)));
                res.clearCookie("at_device", cookieOptions());
                res.json({
                    success: true
                });
            }
        )
    );
}
