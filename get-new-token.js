import { google } from "googleapis";
import dotenv from "dotenv";
import open from "open"; // npm i open

dotenv.config();

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const SCOPES = ['https://www.googleapis.com/auth/gmail.send']; // или mail.google.com, если нужно всё

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent'
});

console.log("Открываем браузер...");
await open(authUrl);

console.log("Перейдите по ссылке и авторизуйтесь, затем вставьте сюда код:");
process.stdin.once('data', async (data) => {
  const code = data.toString().trim();
  
  const { tokens } = await oAuth2Client.getToken(code);
  console.log("\n✅ Новый refresh_token:");
  console.log(tokens.refresh_token);
  console.log("\nЗамените в .env переменную GOOGLE_REFRESH_TOKEN на это значение.");
  process.exit(0);
});