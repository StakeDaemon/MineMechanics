// bot/services/user.js
export function generateUsername(tg_id) {
  const last4 = String(tg_id).slice(-4).padStart(4, "0");
  return `Player${last4}`;
}

export async function ensureUserSupabase(supabase, tg_id, username) {
  // Insert if not exists
  await supabase.from("users").insert({
    tg_id,
    username: username || generateUsername(tg_id)
  }).onConflict("tg_id").ignore();
  // Return user row
  const { data } = await supabase.from("users").select("*").eq("tg_id", tg_id).single();
  return data;
}