// bot/index.js
import dotenv from "dotenv";
dotenv.config();
import TelegramBot from "node-telegram-bot-api";
import fetch from "cross-fetch";
import { supabase } from "./utils/supabaseClient.js";
import { generateUsername, ensureUserSupabase } from "./services/user.js";
import { notifyAdmin, notifyUser } from "./services/notify.js";
import { depositPages } from "./keyboards/depositCoins.js";
import { MAIN_MENU } from "./keyboards/mainMenu.js";
import { userState } from "./state.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN missing");
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const SERVER_BASE_URL = process.env.SERVER_BASE_URL || process.env.SERVER_BASE_URL || "https://minemechanics-backend.vercel.app";
const MIN_DEPOSIT = Number(process.env.MIN_DEPOSIT || 0.2);
const MAX_DEPOSIT = Number(process.env.MAX_DEPOSIT || 1000000);
const APY_PERCENT = Number(process.env.APY_PERCENT || 19);

// HELPERS
async function ensureUser(tg_id, username) {
  return ensureUserSupabase(supabase, tg_id, username);
}

function formatMoney(v) {
  return Number(v || 0).toFixed(6);
}

// Start
bot.onText(/\/start/, async (msg) => {
  const tg = msg.from.id;
  await ensureUser(tg, msg.from.username);
  await bot.sendMessage(tg, "🎉 Welcome to MineMechanics — gamified mining simulator.", MAIN_MENU);
  await notifyAdmin(`<b>New user</b>\nID: ${tg}`);
});

// Show deposit pages on /deposit or GET MINEM
bot.onText(/\/deposit$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "Choose a coin to deposit:", { reply_markup: { inline_keyboard: depositPages[0] }});
});

// Callback queries: pages & coin selection & inline actions
bot.on("callback_query", async (cq) => {
  const data = cq.data;
  const chatId = cq.from.id;
  const msg = cq.message;

  try {
    if (!data) return;

    // paging
    if (data.startsWith("page_")) {
      const page = Number(data.split("_")[1]) - 1;
      await bot.editMessageReplyMarkup({ inline_keyboard: depositPages[page] }, { chat_id: msg.chat.id, message_id: msg.message_id });
      return bot.answerCallbackQuery(cq.id);
    }

    // coin selected
    if (data.startsWith("coin_")) {
      const coin = data.split("_")[1];
      userState[chatId] = { stage: "await_deposit_amount", coin };
      await bot.sendMessage(chatId, `You selected ${coin}. Enter amount in USD (min ${MIN_DEPOSIT}):`);
      return bot.answerCallbackQuery(cq.id);
    }

    // when user presses view miner -> show sell options etc (we'll support viewminer_123)
    if (data.startsWith("viewminer_")) {
      const minerId = Number(data.split("_")[1]);
      const { data: miner } = await supabase.from("miners").select("*").eq("id", minerId).single();
      if (!miner) return bot.sendMessage(chatId, "Miner not found.");
      const text = `Miner #${miner.id}\nOwner: ${miner.owner_tg_id}\nPrice: $${formatMoney(miner.price_usd)}\nMonthly reward: ${formatMoney(miner.monthly_reward_m2)} M²\nCreated: ${miner.created_at}`;
      const inline = { inline_keyboard: [
        [{ text: "Sell (85%)", callback_data: `sellopt_monthly_${miner.id}` }],
        [{ text: "Sell (weekly 60%)", callback_data: `sellopt_weekly_${miner.id}` }],
        [{ text: "Sell (instant 30%)", callback_data: `sellopt_instant_${miner.id}` }],
        [{ text: "Gift", callback_data: `giftinit_${miner.id}` }],
        [{ text: "Home", callback_data: "menu_home" }]
      ]};
      return bot.sendMessage(chatId, text, { reply_markup: inline });
    }

    // Sell options
    if (data.startsWith("sellopt_")) {
      const parts = data.split("_");
      const opt = parts[1]; // monthly, weekly, instant
      const minerId = Number(parts[2]);
      const { data: miner } = await supabase.from("miners").select("*").eq("id", minerId).single();
      if (!miner) return bot.sendMessage(chatId, "Miner not found.");
      if (Number(miner.owner_tg_id) !== Number(chatId)) return bot.sendMessage(chatId, "You do not own this miner.");
      // compute payout
      let payout = 0;
      if (opt === "monthly") payout = Number(miner.price_usd) * 0.85;
      else if (opt === "weekly") payout = Number(miner.price_usd) * 0.60;
      else if (opt === "instant") payout = Number(miner.price_usd) * 0.30;
      // delete miner and credit (we process immediate for all options for simplicity)
      await supabase.from("miners").delete().eq("id", minerId);
      await supabase.rpc("credit_user_minem", { p_tg_id: chatId, p_amount: payout }).catch(async (e) => {
        // fallback update
        const { data: u } = await supabase.from("users").select("balance_minem").eq("tg_id", chatId).single();
        const cur = Number(u?.balance_minem || 0);
        await supabase.from("users").update({ balance_minem: cur + payout }).eq("tg_id", chatId);
      });
      await supabase.from("admin_logs").insert({ action: "sell_miner", payload: { tg_id: chatId, minerId, option: opt, payout }});
      await notifyAdmin(`<b>Miner sold</b>\nUser: ${chatId}\nMiner: ${minerId}\nOption: ${opt}\nPayout: ${payout}`);
      return bot.sendMessage(chatId, `Miner sold. You received ${payout} Minem.`, MAIN_MENU);
    }

    // Gift init
    if (data.startsWith("giftinit_")) {
      const minerId = Number(data.split("_")[1]);
      userState[chatId] = { stage: "gift_target", minerId };
      return bot.sendMessage(chatId, "Enter recipient Telegram ID to gift this miner:");
    }

    if (data === "menu_home") {
      return bot.sendMessage(chatId, "Main menu", MAIN_MENU);
    }

  } catch (err) {
    console.error("callback error:", err);
    return bot.answerCallbackQuery(cq.id, { text: "Error" });
  }
});

// Text handler - stateful flows and main buttons
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();

    // ignore commands handled elsewhere
    if (text.startsWith("/")) return;

    const state = userState[chatId];

    // Deposit flow: user typed amount
    if (state && state.stage === "await_deposit_amount") {
      const amount = Number(text);
      if (isNaN(amount) || amount < MIN_DEPOSIT || amount > MAX_DEPOSIT) {
        return bot.sendMessage(chatId, `Enter a valid amount between ${MIN_DEPOSIT} and ${MAX_DEPOSIT}`);
      }
      const coin = state.coin || "BTC";
      // call backend to create invoice
      const resp = await fetch(`${SERVER_BASE_URL}/api/deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tg_id: chatId, amount_usd: amount, chain: coin })
      });
      const j = await resp.json();
      if (!j.ok) {
        delete userState[chatId];
        return bot.sendMessage(chatId, "Failed to create deposit: " + (j.error || JSON.stringify(j)));
      }
      const payUrl = j.paymentUrl || j.payment_url || (j.rawResponse && j.rawResponse.data && j.rawResponse.data.paymentUrl);
      await bot.sendMessage(chatId, `🔗 Open to pay: ${payUrl}\nAfter payment you will get a confirmation here.`);
      await notifyAdmin(`<b>Deposit created</b>\nUser: ${chatId}\nAmount: $${amount}\nCoin: ${coin}\nRef: ${j.referenceId}`);
      delete userState[chatId];
      return;
    }

    // HOW TO START
    if (text.toUpperCase() === "HOW TO START") {
      return bot.sendMessage(chatId,
`HOW TO START:
1) GET MINEM → deposit via crypto
2) BUY MINER using Minem (Buy Miner)
3) Miner generates M² every month (distribute_monthly_rewards cron)
4) Pay maintenance via TOP UP PACKS
5) Redeem M² via REDEEM M²
`, MAIN_MENU);
    }

    // GET MINEM (alias to deposit pages)
    if (/GET MINEM/i.test(text) || /DEPOSIT/i.test(text)) {
      return bot.sendMessage(chatId, "Choose a coin to deposit:", { reply_markup: { inline_keyboard: depositPages[0] }});
    }

    // BUY MINER: ask amount to buy (min $1)
    if (text.toUpperCase() === "BUY MINER") {
      userState[chatId] = { stage: "buy_miner_amount" };
      return bot.sendMessage(chatId, "Enter the cost of your miner in USD (min $1):");
    }

    if (state && state.stage === "buy_miner_amount") {
      const price = Number(text);
      if (isNaN(price) || price < 1) return bot.sendMessage(chatId, "Enter a valid price >= 1");
      // show monthly M² reward using APY formula (principal × (APY / 100) × (days / 365)), for 30 days:
      const monthlyReward = price * (APY_PERCENT / 100) * (30 / 365);
      userState[chatId] = { stage: "buy_miner_confirm", price, monthlyReward };
      const inline = { inline_keyboard: [[{ text: "Confirm", callback_data: "confirm_buyminer" }, { text: "Cancel", callback_data: "menu_home" }]] };
      return bot.sendMessage(chatId, `Miner Cost: $${price}\nMonthly M² Reward (approx): ${monthlyReward.toFixed(6)}\nMaintenance: $0.0001 per $ miner\nConfirm purchase?`, { reply_markup: inline });
    }

    // Confirm buy miner is handled via callback_query "confirm_buyminer"
    // Balance
    if (text.toUpperCase() === "BALANCE") {
      await ensureUser(chatId);
      const { data: u } = await supabase.from("users").select("balance_minem,balance_m2,packs").eq("tg_id", chatId).single();
      const { data: summary } = await supabase.from("user_summary").select("*").eq("tg_id", chatId).maybeSingle();
      const out = `Balance:\nMinem: ${formatMoney(u?.balance_minem)}\nM²: ${formatMoney(u?.balance_m2)}\nPacks($): ${formatMoney(u?.packs)}\nTotal miner value: ${formatMoney(summary?.total_miner_value)}\nMonthly M²: ${formatMoney(summary?.total_monthly_reward_m2)}`;
      return bot.sendMessage(chatId, out, MAIN_MENU);
    }

    // MY MINER
    if (text.toUpperCase() === "MY MINER") {
      await ensureUser(chatId);
      const { data: miners } = await supabase.from("miners").select("*").eq("owner_tg_id", chatId).order("id");
      if (!miners || miners.length === 0) return bot.sendMessage(chatId, "You have no miners. Buy one from BUY MINER.", MAIN_MENU);
      let out = "Your miners:\n\n";
      const inline = { inline_keyboard: [] };
      miners.forEach(m => {
        out += `#${m.id} — $${formatMoney(m.price_usd)} — ${formatMoney(m.monthly_reward_m2)} M²/mo\n`;
        inline.inline_keyboard.push([{ text: `View #${m.id}`, callback_data: `viewminer_${m.id}` }]);
      });
      inline.inline_keyboard.push([{ text: "Home", callback_data: "menu_home" }]);
      return bot.sendMessage(chatId, out, { reply_markup: inline });
    }

    // SELL MINER button => list miners to sell
    if (text.toUpperCase() === "SELL MINER") {
      const { data: miners } = await supabase.from("miners").select("*").eq("owner_tg_id", chatId);
      if (!miners || miners.length === 0) return bot.sendMessage(chatId, "No miners to sell.", MAIN_MENU);
      const inline = { inline_keyboard: miners.map(m => [{ text: `Sell #${m.id} ($${formatMoney(m.price_usd)})`, callback_data: `sellinit_${m.id}` }]).concat([[{ text: "Home", callback_data: "menu_home" }]]) };
      userState[chatId] = { stage: "sell_choose" };
      return bot.sendMessage(chatId, "Choose miner to sell:", { reply_markup: inline });
    }

    // TOP UP PACKS
    if (text.toUpperCase() === "TOP UP PACKS") {
      userState[chatId] = { stage: "topup_amount" };
      return bot.sendMessage(chatId, "Enter amount in USD to buy packs (1 pack = $1):");
    }
    if (state && state.stage === "topup_amount") {
      const amount = Number(text);
      if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "Invalid amount.");
      // Payment via Minem or M² - for simplicity, we'll let user pay with Minem in this MVP
      const { data: u } = await supabase.from("users").select("balance_minem").eq("tg_id", chatId).single();
      const bal = Number(u?.balance_minem ?? 0);
      if (bal < amount) return bot.sendMessage(chatId, "Insufficient Minem balance.");
      await supabase.from("users").update({ balance_minem: bal - amount, packs: supabase.raw('coalesce(packs,0) + ?', [amount]) }).eq("tg_id", chatId);
      await supabase.from("pack_purchases").insert({ tg_id: chatId, amount_usd: amount, payment_type: "minem", packs: amount });
      await notifyAdmin(`<b>Pack purchase</b>\nUser: ${chatId}\nAmount: $${amount}`);
      delete userState[chatId];
      return bot.sendMessage(chatId, `Packs purchased: $${amount}`, MAIN_MENU);
    }

    // LOOT (call claim_loot RPC)
    if (text.toUpperCase() === "LOOT") {
      try {
        const { data } = await supabase.rpc("claim_loot", { p_tg_id: chatId });
        // RPC returns table (success, awarded, next_claim_at) in our plan; adapt if different
        if (!data) return bot.sendMessage(chatId, "Loot not available yet.");
        // If RPC returns composite, handle accordingly. For safety, try read from user row:
        const { data: user } = await supabase.from("users").select("balance_minem,last_loot_at").eq("tg_id", chatId).single();
        await notifyAdmin(`<b>Loot claimed</b>\nUser: ${chatId}`);
        return bot.sendMessage(chatId, `Loot attempt done. Your Minem: ${formatMoney(user.balance_minem)}`);
      } catch (e) {
        return bot.sendMessage(chatId, "Loot claim error or cooldown. Try later.");
      }
    }

    // REDEEM flows - user clicks REDEEM M²
    if (text.toUpperCase() === "REDEEM M²" || text.toUpperCase() === "REDEEM M2") {
      const inline = { inline_keyboard: [
        [{ text: "Direct Wallet (0.01 M² fee, min 35 M²)", callback_data: "redeem_wallet" }],
        [{ text: "FaucetPay (no fee, min 0.02 M²)", callback_data: "redeem_faucetpay" }],
        [{ text: "Home", callback_data: "menu_home" }]
      ]};
      return bot.sendMessage(chatId, "Choose withdrawal method:", { reply_markup: inline });
    }

    // GIFT MINER
    if (text.toUpperCase() === "GIFT MINER") {
      const { data: miners } = await supabase.from("miners").select("*").eq("owner_tg_id", chatId);
      if (!miners || miners.length === 0) return bot.sendMessage(chatId, "No miners to gift.", MAIN_MENU);
      userState[chatId] = { stage: "gift_choose" };
      const inline = { inline_keyboard: miners.map(m => [{ text: `Gift #${m.id}`, callback_data: `giftinit_${m.id}` }]).concat([[{ text: "Home", callback_data: "menu_home" }]]) };
      return bot.sendMessage(chatId, "Choose miner to gift:", { reply_markup: inline });
    }

    // SWAP M² -> Minem (5% fee)
    if (text.toUpperCase() === "SWAP") {
      userState[chatId] = { stage: "swap_amount" };
      return bot.sendMessage(chatId, "Enter amount of M² to swap to Minem (fee 5%):");
    }
    if (state && state.stage === "swap_amount") {
      const amt = Number(text);
      if (isNaN(amt) || amt <= 0) return bot.sendMessage(chatId, "Invalid amount.");
      const { data: u } = await supabase.from("users").select("balance_m2,balance_minem").eq("tg_id", chatId).single();
      const m2bal = Number(u?.balance_m2 ?? 0);
      if (m2bal < amt) return bot.sendMessage(chatId, "Insufficient M²");
      const feePercent = Number((await supabase.from("settings").select("value").eq("key","swap_fee_percent").single()).data?.value ?? 5);
      const fee = (amt * feePercent) / 100;
      const received = amt - fee;
      await supabase.from("users").update({ balance_m2: m2bal - amt, balance_minem: supabase.raw('coalesce(balance_minem,0) + ?', [received]) }).eq("tg_id", chatId);
      await supabase.from("swaps").insert({ tg_id: chatId, amount_m2: amt, fee_percent: feePercent, minem_received: received });
      await bot.sendMessage(chatId, `Swapped ${amt} M² -> ${received} Minem (fee ${fee}).`, MAIN_MENU);
      delete userState[chatId];
      return;
    }

    // Default - show menu if unknown
  } catch (err) {
    console.error("message handler error:", err);
    try { await bot.sendMessage(msg.chat.id, "An error occurred. Try again later."); } catch(e) {}
  }
});


// Callback handler for confirm buy miner (placed here to avoid splitting)
bot.on("callback_query", async (cq) => {
  const data = cq.data;
  const chatId = cq.from.id;
  try {
    if (data === "confirm_buyminer") {
      const s = userState[chatId];
      if (!s || s.stage !== "buy_miner_confirm") return bot.answerCallbackQuery(cq.id, { text: "No pending purchase" });
      const price = Number(s.price);
      // Check balance
      const { data: u } = await supabase.from("users").select("balance_minem").eq("tg_id", chatId).single();
      const bal = Number(u?.balance_minem ?? 0);
      if (bal < price) return bot.answerCallbackQuery(cq.id, { text: "Insufficient Minem" });
      // calculate monthly reward as approximate for stored monthly_reward_m2
      const monthlyReward = price * (APY_PERCENT / 100) * (30 / 365);
      // insert miner record
      await supabase.from("miners").insert({
        owner_tg_id: chatId,
        price_usd: price,
        monthly_reward_m2: monthlyReward,
        created_at: new Date().toISOString()
      });
      // deduct balance
      await supabase.from("users").update({ balance_minem: bal - price }).eq("tg_id", chatId);
      await supabase.from("admin_logs").insert({ action: "miner_purchase", payload: { tg_id: chatId, price }});
      await notifyAdmin(`<b>Miner purchased</b>\nUser: ${chatId}\nPrice: $${price}`);
      delete userState[chatId];
      await bot.answerCallbackQuery(cq.id, { text: "Miner purchased!" });
      return bot.sendMessage(chatId, `🎉 Miner purchased for $${price}. Monthly M² approx: ${monthlyReward.toFixed(6)}`, MAIN_MENU);
    }
  } catch (err) {
    console.error("confirm_buyminer error:", err);
    return bot.answerCallbackQuery(cq.id, { text: "Error processing purchase" });
  }
});

console.log("Bot started (polling).");