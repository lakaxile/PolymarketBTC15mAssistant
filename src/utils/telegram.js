import { LIVE_CONFIG } from "../live/config.js";

/**
 * Telegram 通知工具
 */
export async function sendTelegramMessage(text, parse_mode = "Markdown") {
    const token = LIVE_CONFIG.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = LIVE_CONFIG.telegramChatId || process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        return; // 未配置则静默
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: parse_mode,
                disable_web_page_preview: true
            })
        });

        if (!res.ok) {
            const errBody = await res.text();
            console.warn(`[TG] Failed to send message: ${res.status} ${errBody}`);
        }
    } catch (e) {
        console.warn(`[TG] Network error sending message: ${e.message}`);
    }
}
