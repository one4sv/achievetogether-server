
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

const MAX_HTML_SIZE = 1024 * 1024;
const REQUEST_TIMEOUT = 8000;
const MAX_REDIRECTS = 4;

const IPV4_BLOCKED = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
];

function ipv4ToNumber(address) {
    return address.split(".").reduce(
        (result, part) => result * 256 + Number(part),
        0
    );
}

function ipv6ToBigInt(address) {
    let ip = address.toLowerCase();

    if (ip.includes(".")) {
        const lastColon = ip.lastIndexOf(":");
        const ipv4 = ip.slice(lastColon + 1);

        if (isIP(ipv4) !== 4) return null;

        const parts = ipv4.split(".").map(Number);
        const high = (parts[0] << 8) | parts[1];
        const low = (parts[2] << 8) | parts[3];

        ip = `${ip.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
    }

    const halves = ip.split("::");

    if (halves.length > 2) return null;

    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1]
        ? halves[1].split(":")
        : [];

    const missing = 8 - left.length - right.length;

    if (
        missing < 0 ||
        (halves.length === 1 && missing !== 0) ||
        (halves.length === 2 && missing < 1)
    ) {
        return null;
    }

    const groups = [
        ...left,
        ...Array(missing).fill("0"),
        ...right,
    ];

    if (
        groups.length !== 8 ||
        groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
    ) {
        return null;
    }

    return groups.reduce(
        (result, part) => (result << 16n) | BigInt(`0x${part}`),
        0n
    );
}

function inIpv4Range(address, network, prefix) {
    const ip = ipv4ToNumber(address);
    const base = ipv4ToNumber(network);
    const mask = prefix === 0
        ? 0
        : (0xffffffff << (32 - prefix)) >>> 0;

    return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

function inIpv6Range(address, network, prefix) {
    const ip = ipv6ToBigInt(address);
    const base = ipv6ToBigInt(network);

    if (ip === null || base === null) return false;

    const shift = BigInt(128 - prefix);

    return (ip >> shift) === (base >> shift);
}

function isPrivateAddress(address) {
    const family = isIP(address);

    if (family === 4) {
        return IPV4_BLOCKED.some(([network, prefix]) =>
            inIpv4Range(address, network, prefix)
        );
    }

    if (family === 6) {
        const ip = address.toLowerCase();

        if (
            ip.startsWith("::ffff:") ||
            ip.startsWith("::") ||
            ip.startsWith("64:ff9b:") ||
            ip.startsWith("64:ff9b:1:")
        ) {
            return true;
        }

        // Разрешаем только глобальные IPv6-адреса из 2000::/3.
        if (!inIpv6Range(ip, "2000::", 3)) {
            return true;
        }

        // Специальные назначения и переходные механизмы.
        return (
            inIpv6Range(ip, "2001::", 23) ||
            inIpv6Range(ip, "2002::", 16)
        );
    }

    return true;
}

async function resolvePublicAddress(hostname) {
    const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const family = isIP(normalized);

    if (family) {
        if (isPrivateAddress(normalized)) {
            throw new Error("Private addresses are not allowed");
        }

        return {
            address: normalized,
            family,
        };
    }

    if (
        normalized === "localhost" ||
        normalized.endsWith(".localhost") ||
        normalized.endsWith(".local") ||
        normalized.endsWith(".internal")
    ) {
        throw new Error("Local addresses are not allowed");
    }

    const addresses = await lookup(normalized, {
        all: true,
        verbatim: true,
    });

    if (
        !addresses.length ||
        addresses.some(({ address }) => isPrivateAddress(address))
    ) {
        throw new Error("Private addresses are not allowed");
    }

    return addresses[0];
}

async function validateUrl(value) {
    let url;

    try {
        url = new URL(value);
    } catch {
        throw new Error("Invalid URL");
    }

    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Unsupported protocol");
    }

    if (url.username || url.password) {
        throw new Error("Credentials are not allowed");
    }

    if (!url.hostname) {
        throw new Error("Invalid hostname");
    }

    const resolved = await resolvePublicAddress(url.hostname);

    return {
        url,
        resolved,
    };
}

function requestPinned(url, resolved) {
    return new Promise((resolve, reject) => {
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const family = isIP(hostname);
        const client = url.protocol === "https:" ? https : http;

        const options = {
            protocol: url.protocol,
            hostname,
            port: url.port || undefined,
            method: "GET",
            path: `${url.pathname}${url.search}`,
            agent: false,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            headers: {
                Host: url.host,
                "User-Agent": "AT-LinkPreview/1.0",
                Accept: "text/html,application/xhtml+xml",
            },
        };

        if (!family) {
            options.lookup = (_hostname, lookupOptions, callback) => {
                if (lookupOptions.all) {
                    callback(null, [resolved]);
                } else {
                    callback(null, resolved.address, resolved.family);
                }
            };

            if (url.protocol === "https:") {
                options.servername = hostname;
            }
        }

        const request = client.request(options, (response) => {
            resolve(response);
        });

        request.on("error", reject);
        request.end();
    });
}

function decodeHtml(value) {
    return value
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, code) => {
            const number = Number(code);

            return number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
                ? String.fromCodePoint(number)
                : _;
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
            const number = parseInt(code, 16);

            return number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
                ? String.fromCodePoint(number)
                : _;
        })
        .trim();
}

function getMeta(html, key, attribute = "property") {
    const tags = html.match(/<meta\b[^>]*>/gi) || [];

    for (const tag of tags) {
        const attrs = {};
        const attrRegex = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
        let match;

        while ((match = attrRegex.exec(tag)) !== null) {
            attrs[match[1].toLowerCase()] =
                match[2] ?? match[3] ?? match[4] ?? "";
        }

        if (attrs[attribute]?.toLowerCase() === key.toLowerCase()) {
            return decodeHtml(attrs.content || "");
        }
    }

    return "";
}

function getTitle(html) {
    return (
        getMeta(html, "og:title") ||
        getMeta(html, "twitter:title", "name") ||
        decodeHtml(
            html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
                ?.replace(/<[^>]*>/g, "") || ""
        )
    );
}

function getDescription(html) {
    return (
        getMeta(html, "og:description") ||
        getMeta(html, "description", "name") ||
        getMeta(html, "twitter:description", "name")
    );
}

async function readHtml(response) {
    const contentType = response.headers["content-type"] || "";

    if (
        !contentType.includes("text/html") &&
        !contentType.includes("application/xhtml+xml")
    ) {
        response.destroy();
        throw new Error("Not an HTML page");
    }

    const declaredLength = Number(response.headers["content-length"]);

    if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_SIZE) {
        response.destroy();
        throw new Error("Page is too large");
    }

    const chunks = [];
    let size = 0;

    for await (const chunk of response) {
        size += chunk.length;

        if (size > MAX_HTML_SIZE) {
            response.destroy();
            throw new Error("Page is too large");
        }

        chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
}

async function fetchPage(initialUrl) {
    let value = initialUrl;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
        const { url, resolved } = await validateUrl(value);
        const response = await requestPinned(url, resolved);

        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            const location = response.headers.location;
            response.destroy();

            if (!location) {
                throw new Error("Invalid redirect");
            }

            if (i === MAX_REDIRECTS) {
                throw new Error("Too many redirects");
            }

            value = new URL(location, url).href;
            continue;
        }

        if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
        ) {
            response.destroy();
            throw new Error("Page unavailable");
        }

        const html = await readHtml(response);

        return {
            url: url.href,
            hostname: url.hostname,
            title: getTitle(html) || url.hostname,
            description: getDescription(html),
            image: getImage(html, url.href),
        };
    }

    throw new Error("Too many redirects");
}

function getImage(html, pageUrl) {
    const value =
        getMeta(html, "og:image") ||
        getMeta(html, "og:image:secure_url") ||
        getMeta(html, "twitter:image", "name");

    if (!value) return "";

    try {
        const imageUrl = new URL(value, pageUrl);

        if (
            !["http:", "https:"].includes(imageUrl.protocol) ||
            imageUrl.username ||
            imageUrl.password
        ) {
            return "";
        }

        return imageUrl.href;
    } catch {
        return "";
    }
}


export default function (app) {
    app.get("/link-preview", async (req, res) => {
        try {
            const value = req.query.url;

            if (
                typeof value !== "string" ||
                !value.trim() ||
                value.length > 2048
            ) {
                return res.status(400).json({
                    success: false,
                    error: "Invalid URL",
                });
            }

            const result = await fetchPage(value);

            return res.json({
                success: true,
                ...result,
            });
        } catch {
            return res.status(400).json({
                success: false,
                error: "Preview unavailable",
            });
        }
    });
}
