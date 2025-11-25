// bot/services/notify.js
import fetch from "cross-fetch";

export async function notifyAdmin(text) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.ADMIN_CHAT_ID;
    if (!token || !chat) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" })
    });
  } catch (e) {
    console.warn("notifyAdmin error:", e?.message || e);
  }
}

export async function notifyUser(tg, text) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || !tg) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg, text, parse_mode: "HTML" })
    });
  } catch (e) {
    console.warn("notifyUser error:", e?.message || e);
  }
}