export const CHAT_MEDIA_LIMIT = 50_000_000;
const legacyLimit = 10 * 1024 * 1024;
const totalBytes = Symbol("chatAttachmentBytes");

// Multer memory storage with a per-request aggregate budget. Continue draining
// oversized streams without retaining bytes, and reject before route mutation.
export const chatAttachmentStorage = {
  _handleFile(req, file, callback) {
    let size = 0;
    let chunks = [];
    let exceeded = false;
    file.stream.on("data", chunk => {
      size += chunk.length;
      req[totalBytes] = (req[totalBytes] || 0) + chunk.length;
      if (req[totalBytes] > CHAT_MEDIA_LIMIT) {
        exceeded = true;
        chunks = [];
      } else if (!exceeded) {
        chunks.push(chunk);
      }
    });
    file.stream.once("end", () => {
      if (exceeded) {
        const error = new Error("Chat attachment aggregate limit exceeded");
        error.code = "CHAT_TOTAL_FILE_SIZE";
        callback(error);
        return;
      }
      callback(null, { buffer: Buffer.concat(chunks, size), size });
    });
  },
  _removeFile(_req, file, callback) {
    delete file.buffer;
    callback(null);
  }
};

export async function ensureChatMediaLimit(supabase) {
  try {
    const { data: bucket, error } = await supabase.storage.getBucket("media");
    if (error) throw error;
    // Do not override any different limit, public/private state or MIME policy.
    if (!bucket || bucket.public !== false || Number(bucket.file_size_limit) !== legacyLimit) return;
    const { error: updateError } = await supabase.storage.updateBucket("media", {
      public: false,
      fileSizeLimit: CHAT_MEDIA_LIMIT,
      allowedMimeTypes: bucket.allowed_mime_types ?? null
    });
    if (updateError) throw updateError;
    console.log("Chat media bucket limit updated to 50 MB");
  } catch (error) {
    console.error("Chat media bucket configuration not updated:", error?.message || error);
  }
}
