import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function clean(value: unknown) {
  return String(value || "").trim();
}

function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function hmacSha256(key: Uint8Array, data: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)),
  );
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyTelegramInitData(initData: string) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");

  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  if (!initData) throw new Error("Telegram initData is missing");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) throw new Error("Telegram hash is missing");

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await hmacSha256(
    new TextEncoder().encode("WebAppData"),
    botToken,
  );

  const calculatedHash = bytesToHex(await hmacSha256(secretKey, dataCheckString));

  if (!timingSafeEqualHex(calculatedHash, hash)) {
    throw new Error("Invalid Telegram initData");
  }

  const userRaw = params.get("user");

  if (!userRaw) throw new Error("Telegram user is missing");

  const user = JSON.parse(userRaw);

  if (!user?.id) throw new Error("Telegram user id is missing");

  return user;
}

function requireServerEnv() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Server env is not configured");
  }

  return { supabaseUrl, serviceRoleKey };
}

async function findUserByTelegramId(supabase: any, telegramId: number) {
  const { data, error } = await supabase
    .from("User")
    .select("id, telegram_id")
    .eq("telegram_id", telegramId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) throw new Error("Пользователь не найден");

  return data;
}

function normalizeChoice(value: unknown) {
  const choice = clean(value);
  const lower = choice.toLowerCase();

  if (["red", "красное", "красный"].includes(lower)) return "red";
  if (["black", "чёрное", "черное", "чёрный", "черный"].includes(lower)) return "black";
  if (["green", "зелёное", "зеленое", "зелёный", "зеленый"].includes(lower)) return "green";

  throw new Error("Некорректный выбор");
}

function normalizeBet(value: unknown) {
  const raw = String(value || "")
    .replace(",", ".")
    .replace(/[^0-9.]/g, "");

  const bet = Math.floor(Number(raw));

  if (!Number.isFinite(bet) || bet <= 0) {
    throw new Error("Некорректная ставка");
  }

  return bet;
}

function normalizePublicError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object"
        ? JSON.stringify(error)
        : String(error || "");

  const lower = message.toLowerCase();

  if (lower.includes("недостаточно")) return "Недостаточно средств";
  if (lower.includes("минимальная ставка")) return message;
  if (lower.includes("максимальная ставка")) return message;
  if (lower.includes("временно недоступна")) return "Игра временно недоступна";
  if (lower.includes("пользователь не найден")) return "Пользователь не найден";
  if (lower.includes("некорректный выбор")) return "Некорректный выбор";
  if (lower.includes("некорректная ставка")) return "Некорректная ставка";
  if (lower.includes("telegram")) return "Ошибка авторизации Telegram";

  return message || "Ошибка игры";
}

Deno.serve(async (req) => {
  console.log("[redblack]", req.method, new Date().toISOString());

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json();
    const action = clean(body.action || "play");
    const initData = clean(body.initData);
    const telegramUser = await verifyTelegramInitData(initData);

    const { supabaseUrl, serviceRoleKey } = requireServerEnv();
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const dbUser = await findUserByTelegramId(supabase, Number(telegramUser.id));

    if (action === "state") {
      const { data, error } = await supabase.rpc("redblack_get_state", {
        p_user_id: dbUser.id,
        p_telegram_id: Number(telegramUser.id),
      });

      if (error) {
        console.error("[redblack] state rpc error:", error);
        throw new Error(error.message || JSON.stringify(error));
      }

      return json({ ok: true, ...data });
    }

    if (action === "play") {
      const choice = normalizeChoice(body.choice);
      const bet = normalizeBet(body.bet);

      const { data, error } = await supabase.rpc("redblack_play", {
        p_user_id: dbUser.id,
        p_telegram_id: Number(telegramUser.id),
        p_choice: choice,
        p_bet_amount: bet,
      });

      if (error) {
        console.error("[redblack] play rpc error:", error);
        throw new Error(error.message || JSON.stringify(error));
      }

      return json({ ok: true, ...data });
    }

    throw new Error("Unknown action");
  } catch (error) {
    console.error("[redblack] REAL ERROR:", error);

    const realMessage =
      error instanceof Error
        ? error.message
        : typeof error === "object"
          ? JSON.stringify(error)
          : String(error || "Unknown error");

    return json(
      {
        ok: false,
        error: normalizePublicError(realMessage),
        debug_error: realMessage,
      },
      400,
    );
  }
});
