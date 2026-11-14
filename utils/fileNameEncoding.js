// Multer historically interpreted UTF-8 names as Latin-1 when reading multipart headers.
export function normalizeUploadFileName(name) {
    if (!/[ÐÑ]/.test(name) || [...name].some(char => char.charCodeAt(0) > 255)) return name;
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return decoded.includes("\uFFFD") || !/[\u0400-\u04FF]/.test(decoded) ? name : decoded;
}
