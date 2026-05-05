export const withRetry = async (operation, maxRetries = 4) => {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (err) {
            lastError = err;

            const isNetworkError =
                err.message?.includes("fetch failed") ||
                err.cause?.message?.includes("fetch") ||
                err.name === "TypeError" ||
                err.code === "ECONNRESET" ||
                err.code === "ENOTFOUND";

            if (!isNetworkError || attempt === maxRetries) {
                console.error(`❌ Supabase запрос окончательно провалился после ${attempt + 1} попыток:`, err);
                throw err;
            }

            const delay = Math.min(800 * Math.pow(2, attempt), 8000);
            console.warn(`⚠️ [RETRY] Supabase (${attempt + 1}/${maxRetries + 1}) — повтор через ${delay}мс: ${err.message}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
};