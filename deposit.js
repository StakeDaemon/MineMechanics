// backend/api/deposit.js
import { createClient } from "@supabase/supabase-js";
import https from "https";
import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CCPayment config (set on Vercel)
const CCPAY_APP_ID = process.env.CCPAY_APP_ID;
const CCPAY_APP_SECRET = process.env.CCPAY_APP_SECRET;
const CCPAY_DEPOSIT_API = process.env.CCPAY_DEPOSIT_API; // e.g. https://api.ccpay.example/v1/invoice
const RETURN_URL = process.env.RETURN_URL || "https://t.me/YourBotUsername";

function signPayload(appId, appSecret, timestamp, bodyString) {
  let signText = appId + timestamp;
  if (bodyString && bodyString.length) signText += bodyString;
  return crypto.createHmac("sha256", appSecret).update(signText).digest("hex");
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const { tg_id, amount_usd, chain } = body;
    if (!tg_id || !amount_usd) return res.status(400).json({ error: "tg_id and amount_usd required" });

    // prepare invoice payload
    const referenceId = `MM-${tg_id}-${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const callbackUrl = `${process.env.SERVER_BASE_URL}/api/ccpayment-webhook`;

    const payload = {
      referenceId,
      amount: Number(amount_usd),
      currency: "USD",
      chain: chain || "BTC",
      callbackUrl,
      returnUrl: RETURN_URL,
      metadata: { tg_id }
    };

    const payloadStr = JSON.stringify(payload);
    const signature = signPayload(CCPAY_APP_ID, CCPAY_APP_SECRET, timestamp, payloadStr);

    // Send to CCPayment provider
    const url = new URL(CCPAY_DEPOSIT_API);
    const options = {
      hostname: url.hostname,
      path: url.pathname + (url.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Appid": CCPAY_APP_ID,
        "Sign": signature,
        "Timestamp": timestamp
      }
    };

    const request = https.request(options, (response) => {
      let raw = "";
      response.on("data", (c) => raw += c);
      response.on("end", async () => {
        let json;
        try { json = JSON.parse(raw); } catch (e) { return res.status(500).json({ error: "Invalid CCPayment response", raw }); }

        // Extract payment URL (adjust according to CCPayment actual response)
        const paymentUrl = json?.data?.paymentUrl || json?.data?.checkoutUrl || json?.paymentUrl;
        if (!paymentUrl) return res.status(500).json({ error: "Payment URL missing", json });

        // insert pending payment in supabase
        await supabase.from("payments").insert({
          tg_id: tg_id,
          amount_usd: Number(amount_usd),
          reference_id: referenceId,
          track_id: json?.data?.txHash ?? null,
          status: "pending",
          created_at: new Date().toISOString()
        });

        return res.status(200).json({ ok: true, paymentUrl, referenceId, rawResponse: json });
      });
    });

    request.on("error", (err) => res.status(500).json({ error: err.message }));
    request.write(payloadStr);
    request.end();

  } catch (err) {
    console.error("deposit error", err);
    return res.status(500).json({ error: err.message || err });
  }
}