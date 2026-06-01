import { createClient } from "npm:@supabase/supabase-js@2";

type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
  language_code?: string;
  is_premium?: boolean;
};

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
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function hmacSha256(key: string | Uint8Array, data: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)),
  );
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function validateTelegramInitData(
  initData: string,
  botToken: string,
): Promise<TelegramUser> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) throw new Error("Telegram hash is missing");

  params.delete("hash");

  const authDate = Number(params.get("auth_date") || 0);
  const now = Math.floor(Date.now() / 1000);

  if (!authDate || now - authDate > 86400) {
    throw new Error("Telegram initData is expired");
  }

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await hmacSha256("WebAppData", botToken);
  const calculatedHash = toHex(await hmacSha256(secretKey, dataCheckString));

  if (!timingSafeEqual(calculatedHash, hash)) {
    throw new Error("Invalid Telegram initData signature");
  }

  const userRaw = params.get("user");

  if (!userRaw) throw new Error("Telegram user is missing");

  return JSON.parse(userRaw) as TelegramUser;
}

function safeNumber(value: unknown, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function cleanText(value: unknown) {
  return String(value || "").trim();
}

function moneyInt(value: unknown) {
  const amount = Math.floor(safeNumber(value, 0));
  return amount > 0 ? amount : 0;
}

async function safeSelect<T = any>(query: PromiseLike<{ data: T | null; error: any }>, fallback: T) {
  try {
    const { data, error } = await query;
    if (error) throw error;
    return data ?? fallback;
  } catch (_error) {
    return fallback;
  }
}

async function getCurrentUser(
  supabase: ReturnType<typeof createClient>,
  telegramUser: TelegramUser,
) {
  const { data: user, error } = await supabase
    .from("User")
    .select(`
      id,
      telegram_id,
      username,
      first_name,
      last_name,
      referral_code,
      invited_by_user_id,
      partner_code_used,
      partner_bound_at,
      partner_percent,
      partner_pending_balance,
      partner_balance,
      is_partner_active
    `)
    .eq("telegram_id", telegramUser.id)
    .single();

  if (error || !user) {
    throw new Error("User not found. Open telegram-auth first.");
  }

  return user;
}

async function getCurrentBalance(
  supabase: ReturnType<typeof createClient>,
  userId: string,
) {
  const { data, error } = await supabase
    .from("Balance")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  return safeNumber(data?.balance, 0);
}


function isApprovedFinancialStatus(statusValue: unknown) {
  const status = String(statusValue || "").trim().toLowerCase();

  if (!status) return false;

  return [
    "approved",
    "success",
    "succeeded",
    "completed",
    "complete",
    "paid",
    "confirmed",
    "done",
    "успешно",
    "выполнено",
    "оплачено",
    "одобрено",
    "подтверждено",
  ].some((item) => status.includes(item));
}

function isDepositType(typeValue: unknown) {
  const type = String(typeValue || "").trim().toLowerCase();
  return type === "deposit" || type.includes("пополн");
}

function isWithdrawType(typeValue: unknown) {
  const type = String(typeValue || "").trim().toLowerCase();
  return type === "withdraw" || type.includes("вывод");
}

async function getFinancialTotals(
  supabase: ReturnType<typeof createClient>,
  userId: string,
) {
  try {
    const { data, error } = await supabase
      .from("Transaction")
      .select("type, status, amount")
      .eq("user_id", userId)
      .limit(5000);

    if (error) throw error;

    let totalDeposits = 0;
    let totalWithdrawals = 0;

    for (const row of data || []) {
      if (!isApprovedFinancialStatus(row.status)) continue;

      const amount = Math.abs(safeNumber(row.amount, 0));
      if (amount <= 0) continue;

      if (isDepositType(row.type)) totalDeposits += amount;
      if (isWithdrawType(row.type)) totalWithdrawals += amount;
    }

    return {
      totalDeposits,
      totalWithdrawals,
      source: "Transaction",
    };
  } catch (error) {
    console.warn("[partner-code] Transaction totals unavailable:", error);

    return {
      totalDeposits: 0,
      totalWithdrawals: 0,
      source: "fallback_zero",
    };
  }
}

async function getPartnerStats(
  supabase: ReturnType<typeof createClient>,
  userId: string,
) {
  const [{ count: referralsCount, error: referralsError }, earningsResult] =
    await Promise.all([
      supabase
        .from("PartnerReferral")
        .select("id", { count: "exact", head: true })
        .eq("partner_user_id", userId),

      supabase
        .from("PartnerEarning")
        .select(
          "id, referral_user_id, base_loss_amount, commission_amount, percent, status, created_at",
        )
        .eq("partner_user_id", userId)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

  if (referralsError) throw referralsError;
  if (earningsResult.error) throw earningsResult.error;

  const earnings = earningsResult.data ?? [];

  const totals = earnings.reduce(
    (acc, item) => {
      const amount = safeNumber(item.commission_amount);

      acc.total += amount;

      if (item.status === "pending") acc.pending += amount;
      if (item.status === "available") acc.available += amount;
      if (item.status === "paid") acc.paid += amount;
      if (item.status === "cancelled") acc.cancelled += amount;

      return acc;
    },
    { total: 0, pending: 0, available: 0, paid: 0, cancelled: 0 },
  );

  return {
    referrals_count: referralsCount ?? 0,
    earnings,
    totals,
  };
}

async function getPartnerPayoutRequests(
  supabase: ReturnType<typeof createClient>,
  userId: string,
) {
  const data = await safeSelect<any[]>(
    supabase
      .from("PartnerPayoutRequest")
      .select("id, amount, method, requisites, status, admin_comment, created_at, approved_at, paid_at, rejected_at")
      .eq("partner_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    [],
  );

  return Array.isArray(data) ? data : [];
}

function getReservedPayoutAmount(payoutRequests: any[]) {
  return payoutRequests
    .filter((request) => ["pending", "approved"].includes(String(request.status || "")))
    .reduce((sum, request) => sum + safeNumber(request.amount), 0);
}

async function createPartnerPayoutRequest(
  supabase: ReturnType<typeof createClient>,
  user: any,
  payload: any,
) {
  const minPayout = moneyInt(Deno.env.get("MIN_PARTNER_PAYOUT") || "500");
  const amount = moneyInt(payload.amount);
  const method = cleanText(payload.method || "sbp").slice(0, 50) || "sbp";
  const requisites = cleanText(payload.requisites).slice(0, 500);

  if (!amount) {
    return {
      ok: false,
      reason: "bad_amount",
      message: "Введите сумму вывода",
    };
  }

  if (minPayout > 0 && amount < minPayout) {
    return {
      ok: false,
      reason: "min_amount",
      message: `Минимальная сумма вывода: ${minPayout} ₽`,
    };
  }

  if (!requisites) {
    return {
      ok: false,
      reason: "empty_requisites",
      message: "Введите реквизиты для выплаты",
    };
  }

  const payoutRequests = await getPartnerPayoutRequests(supabase, user.id);
  const reserved = getReservedPayoutAmount(payoutRequests);
  const partnerBalance = safeNumber(user.partner_balance, 0);
  const availableToRequest = Math.max(0, partnerBalance - reserved);

  if (amount > availableToRequest) {
    return {
      ok: false,
      reason: "not_enough_partner_balance",
      message: "Недостаточно доступного партнёрского баланса",
      available_to_request: availableToRequest,
    };
  }

  const { data, error } = await supabase
    .from("PartnerPayoutRequest")
    .insert({
      partner_user_id: user.id,
      amount,
      method,
      requisites,
      status: "pending",
    })
    .select("id, amount, method, requisites, status, created_at")
    .single();

  if (error) throw error;

  return {
    ok: true,
    message: "Заявка на вывод создана",
    payout_request: data,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const payload = await req.json();

    const action = String(payload.action || "dashboard");
    const initData = String(payload.initData || "");

    if (!initData) {
      return json({ ok: false, error: "initData is required" }, 400);
    }

    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!botToken || !supabaseUrl || !serviceRoleKey) {
      return json({ ok: false, error: "Server env is not configured" }, 500);
    }

    const telegramUser = await validateTelegramInitData(initData, botToken);
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const user = await getCurrentUser(supabase, telegramUser);

    if (action === "activate") {
      const code = String(payload.code || "").trim();

      if (!code) {
        return json(
          {
            ok: false,
            reason: "empty_code",
            message: "Введите промокод партнёра",
          },
          400,
        );
      }

      const currentBalance = await getCurrentBalance(supabase, user.id);
      const financialTotals = await getFinancialTotals(supabase, user.id);

      const totalDeposits = financialTotals.totalDeposits;
      const totalWithdrawals = financialTotals.totalWithdrawals;

      const { data, error } = await supabase.rpc("activate_partner_promo_code", {
        p_user_id: String(user.id),
        p_code: code,
        p_total_deposits: totalDeposits,
        p_total_withdrawals: totalWithdrawals,
        p_current_balance: currentBalance,
      });

      if (error) throw error;

      return json(data);
    }

    if (action === "request_payout") {
      const result = await createPartnerPayoutRequest(supabase, user, payload);
      return json(result, result.ok ? 200 : 400);
    }

    if (action === "dashboard") {
      const balance = await getCurrentBalance(supabase, user.id);
      const stats = await getPartnerStats(supabase, user.id);
      const payoutRequests = await getPartnerPayoutRequests(supabase, user.id);
      const reservedPayoutAmount = getReservedPayoutAmount(payoutRequests);
      const partnerBalance = safeNumber(user.partner_balance, 0);
      const availableToRequest = Math.max(0, partnerBalance - reservedPayoutAmount);

      return json({
        ok: true,
        user,
        balance,
        ...stats,
        payout_requests: payoutRequests,
        reserved_payout_amount: reservedPayoutAmount,
        available_to_request: availableToRequest,
        min_payout_amount: moneyInt(Deno.env.get("MIN_PARTNER_PAYOUT") || "500"),
      });
    }

    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      401,
    );
  }
});
