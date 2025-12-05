import { broadcastNewMessage, broadcastMessageRead } from "./ws.js";
import dotenv from "dotenv";
import axios from "axios";
dotenv.config();

export function BotInit(supabase) {
    const botNick = "ATBot";
    console.log("API KEY:", process.env.OPENROUTER_API_KEY);

    return {
        botNick,

        async handleMessage({ chatId, userMessage }) {
            try {
                // 1. Отправляем сообщение в ИИ с помощью axios
                const response = await axios.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    {
                        model: process.env.AI_MODEL,
                        messages: [{ role: "user", content: userMessage }],
                        stream: false,
                        provider: {
                            order: ["chutes/bf16", "z-ai", "atlas-cloud/fp8"],
                            allow_fallbacks: true,
                            ignore: ["venice"],
                        },
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                            "HTTP-Referer": process.env.CLIENT_URL,
                            "X-Title": "AchieveTogether",
                            "Content-Type": "application/json",
                        },
                        timeout: 30000,
                    }
                );

                let aiText = response.data.choices?.[0]?.message?.content || "Ошибка: ИИ не вернул текст.";
                aiText = aiText.trimStart();

                // 2. Получаем ID пользователя-бота
                const { data: botUserData, error: botErr } = await supabase
                    .from("users")
                    .select("id")
                    .eq("nick", botNick)
                    .single();

                let botUser;

                if (botErr || !botUserData) {
                    console.error("Bot wasn`t found in users:", botErr);
                    // Запасной ID — используй только если уверен, что такой существует в базе
                    botUser = { id: "ca9123c2-86be-4055-9a51-421a69cb148a" };
                } else {
                    botUser = botUserData;
                }

                // 3. Получаем последнее сообщение в чате
                const { data: lastMessage } = await supabase
                    .from("messages")
                    .select("id, sender_id")
                    .eq("chat_id", chatId)
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .single();

                // 4. Если последнее сообщение — от пользователя, помечаем сообщения пользователя прочитанными ботом
                if (lastMessage && lastMessage.sender_id !== botUser.id) {
                    const { data: unreadMessages } = await supabase
                        .from("messages")
                        .select("id, read_by")
                        .eq("chat_id", chatId)
                        .neq("sender_id", botUser.id)
                        .not("read_by", "cs", `{${botUser.id}}`);

                    for (const msg of unreadMessages) {
                        const newReadBy = [...msg.read_by, botUser.id];
                        await supabase
                            .from("messages")
                            .update({ read_by: newReadBy })
                            .eq("id", msg.id);
                        broadcastMessageRead(chatId, msg.id, botUser.id);
                    }
                }
                // Если последнее сообщение — от бота, не меняем статусы, чтобы пользователь видел их как непрочитанные

                // 5. Сохраняем сообщение ИИ
                const { data: botMsg, error: msgErr } = await supabase
                    .from("messages")
                    .insert([
                        {
                            chat_id: chatId,
                            sender_id: botUser.id,
                            content: aiText,
                        },
                    ])
                    .select()
                    .single();

                if (msgErr) {
                    console.error("Save message bot error:", msgErr);
                    return;
                }

                // 6. Рассылаем новое сообщение по WebSocket
                broadcastNewMessage(chatId, botMsg);
            } catch (err) {
                console.error("AI Error:", err);
                const errorMessage = "Извините, произошла ошибка при работе с ИИ.";

                const { data: botUser, error: botErr } = await supabase
                    .from("users")
                    .select("id")
                    .eq("nick", botNick)
                    .single();

                if (!botErr && botUser) {
                    const { data: errMsg } = await supabase
                        .from("messages")
                        .insert([
                            {
                                chat_id: chatId,
                                sender_id: botUser.id,
                                content: errorMessage,
                                read_by: [botUser.id],
                            },
                        ])
                        .select()
                        .single();

                    if (errMsg) {
                        broadcastNewMessage(chatId, errMsg);
                    }
                }
            }
        },
    };
}
