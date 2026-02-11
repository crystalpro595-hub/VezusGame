// tgSupabase.js
const SUPABASE_URL = "https://bidlyktnwnwvtfehnojw.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJpZGx5a3Rud253dnRmZWhub2p3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NDg3NTQsImV4cCI6MjA4NjQyNDc1NH0.pYnmlTpkj4n3WbaMeAy6hlgO1470pg0Wm4nOV1w9WIY";

function getToken() {
  return localStorage.getItem("tg_access_token");
}
function setToken(t) {
  localStorage.setItem("tg_access_token", t);
}

function createDbClient() {
  const token = getToken();
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  });
}

async function tgEnsureAuth() {
  if (!window.Telegram || !window.Telegram.WebApp) {
    throw new Error("Это должно открываться внутри Telegram WebApp");
  }

  const wa = window.Telegram.WebApp;
  wa.ready();

  const initData = wa.initData || "";
  if (!initData) throw new Error("Нет initData. Открой через Telegram.");

  // каждый запуск WebApp можно спокойно пере-авторизовывать
  const res = await fetch(`${SUPABASE_URL}/functions/v1/tg-webapp-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Auth error");

  setToken(data.access_token);
  return data;
}

async function tgLoadBalanceTo(elementId) {
  const db = createDbClient();
  const { data, error } = await db.from("tg_profiles").select("balance").single();
  if (error) {
    console.error("balance error:", error);
    return;
  }
  const el = document.getElementById(elementId);
  if (el) el.textContent = `${data.balance} VC`;
}
