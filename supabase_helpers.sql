-- credit_user_minem
CREATE OR REPLACE FUNCTION public.credit_user_minem(p_tg_id bigint, p_amount numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.users(tg_id, username) VALUES (p_tg_id, concat('Player', p_tg_id::text))
  ON CONFLICT (tg_id) DO NOTHING;

  UPDATE public.users SET balance_minem = COALESCE(balance_minem,0) + p_amount WHERE tg_id = p_tg_id;
  INSERT INTO public.admin_logs(action, payload) VALUES ('credit_minem', jsonb_build_object('tg_id',p_tg_id,'amount',p_amount));
END;
$$;

-- claim_loot (hourly)
DROP FUNCTION IF EXISTS public.claim_loot(bigint);
CREATE OR REPLACE FUNCTION public.claim_loot(p_tg_id bigint)
RETURNS TABLE(success boolean, awarded numeric, next_claim_at timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  v_last timestamptz;
  v_interval int := COALESCE((SELECT value::int FROM settings WHERE key = 'loot_interval_seconds'), 3600);
  v_amount numeric := COALESCE((SELECT value::numeric FROM settings WHERE key = 'loot_amount_minem'), 0.0001);
BEGIN
  INSERT INTO users(tg_id, username) VALUES (p_tg_id, concat('Player', p_tg_id::text)) ON CONFLICT (tg_id) DO NOTHING;
  SELECT last_loot_at INTO v_last FROM users WHERE tg_id = p_tg_id;
  IF v_last IS NULL THEN v_last := '1970-01-01'::timestamptz; END IF;
  IF EXTRACT(EPOCH FROM (now() - v_last)) < v_interval THEN
    success := false;
    awarded := 0;
    next_claim_at := v_last + (v_interval || ' seconds')::interval;
    RETURN;
  END IF;
  UPDATE users SET balance_minem = COALESCE(balance_minem,0) + v_amount, last_loot_at = now() WHERE tg_id = p_tg_id;
  INSERT INTO loot_claims(tg_id, amount_minem) VALUES (p_tg_id, v_amount);
  success := true;
  awarded := v_amount;
  next_claim_at := now() + (v_interval || ' seconds')::interval;
  RETURN;
END;
$$;

-- user_summary view
CREATE OR REPLACE VIEW public.user_summary AS
SELECT u.tg_id, u.username, u.balance_minem, u.balance_m2, u.packs,
COALESCE(SUM(m.price_usd),0) AS total_miner_value,
COALESCE(SUM(m.monthly_reward_m2),0) AS total_monthly_reward_m2
FROM users u
LEFT JOIN miners m ON m.owner_tg_id = u.tg_id AND COALESCE(m.active,true) = true
GROUP BY u.tg_id, u.username, u.balance_minem, u.balance_m2, u.packs;