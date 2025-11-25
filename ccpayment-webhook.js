// backend/api/ccpayment-webhook.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const payload = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    // example fields: referenceId, status, amount, metadata
    const referenceId = payload?.referenceId || payload?.reference_id || payload?.data?.referenceId;
    const status = (payload?.status || payload?.data?.status || "").toString().toLowerCase();
    const amount = Number(payload?.amount ?? payload?.data?.amount ?? 0);
    const metadata = payload?.metadata || payload?.data?.metadata || {};

    if (!referenceId) {
      console.warn("callback missing referenceId", payload);
      return res.status(400).json({ error: "missing referenceId" });
    }

    // update payment row
    await supabase.from("payments").update({
      status,
      paid_at: ["paid","success","completed","confirmed"].includes(status) ? new Date().toISOString() : null,
      track_id: payload?.txHash ?? payload?.data?.txHash ?? payload?.txid ?? null
    }).eq("reference_id", referenceId);

    // If paid, credit user
    const paidStatuses = ["paid","success","completed","confirmed"];
    if (paidStatuses.includes(status)) {
      // find tg_id
      let tg_id = metadata?.tg_id ?? null;
      if (!tg_id) {
        const { data } = await supabase.from("payments").select("tg_id, amount_usd").eq("reference_id", referenceId).single();
        tg_id = data?.tg_id;
      }
      if (!tg_id) {
        console.warn("Paid callback but can not find tg_id", referenceId);
        return res.status(200).json({ ok: true });
      }

      const creditAmount = amount || (await supabase.from("payments").select("amount_usd").eq("reference_id", referenceId).single()).data?.amount_usd || 0;

      // call RPC to credit user
      try {
        await supabase.rpc("credit_user_minem", { p_tg_id: Number(tg_id), p_amount: Number(creditAmount) });
      } catch (e) {
        // fallback update user table
        await supabase.from("users").insert({ tg_id: Number(tg_id), username: `Player${String(tg_id).slice(-4)}` }).onConflict("tg_id").ignore();
        const { data: u } = await supabase.from("users").select("balance_minem").eq("tg_id", Number(tg_id)).single();
        const cur = Number(u?.balance_minem ?? 0);
        await supabase.from("users").update({ balance_minem: cur + Number(creditAmount) }).eq("tg_id", Number(tg_id));
      }

      // notify admin and return
      await supabase.from("admin_logs").insert({ action: "deposit_confirmed", payload: { tg_id, amount: creditAmount, referenceId }});
      return res.status(200).json({ ok: true });
    }

    // otherwise just log
    await supabase.from("admin_logs").insert({ action: "payment_callback", payload: payload });
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("webhook error", err);
    return res.status(500).json({ error: err.message || err });
  }
}