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

  if (!botToken) {

    throw new Error("TELEGRAM_BOT_TOKEN is not configured");

  }

  if (!initData) {

    throw new Error("Telegram initData is missing");

  }

  const params = new URLSearchParams(initData);

  const hash = params.get("hash");

  if (!hash) {

    throw new Error("Telegram hash is missing");

  }

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

  if (!userRaw) {

    throw new Error("Telegram user is missing");

  }

  const user = JSON.parse(userRaw);

  if (!user?.id) {

    throw new Error("Telegram user id is missing");

  }

  return user;

}

function requireServerEnv() {

  const supabaseUrl = Deno.env.get("SUPABASE_URL");

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {

    throw new Error("Server env is not configured");

  }

  return {

    supabaseUrl,

    serviceRoleKey,

  };

}

async function findUserByTelegramId(supabase: any, telegramId: number) {

  const { data, error } = await supabase

    .from("User")

    .select("id, telegram_id")

    .eq("telegram_id", telegramId)

    .maybeSingle();

  if (error) throw error;

  if (!data?.id) {

    throw new Error("Пользователь не найден");

  }

  return data;

}

function normalizeChoice(value: unknown) {

  const choice = clean(value);

  if (choice === "Орёл" || choice === "Решка") {

    return choice;

  }

  const lower = choice.toLowerCase();

  if (lower === "orel" || lower === "heads") {

    return "Орёл";

  }

  if (lower === "reshka" || lower === "tails") {

    return "Решка";

  }

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



function safeNumber(value: unknown, fallback = 0) {

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : fallback;

}

function pickNumber(source: any, keys: string[], fallback = 0) {

  if (!source || typeof source !== "object") return fallback;

  for (const key of keys) {

    if (source[key] !== undefined && source[key] !== null && source[key] !== "") {

      const value = safeNumber(source[key], Number.NaN);

      if (Number.isFinite(value)) return value;

    }

  }

  return fallback;

}

function lowerText(value: unknown) {

  return String(value || "").trim().toLowerCase();

}

function isFinalMoneyStatus(row: any) {

  const status = lowerText(row?.status || row?.state || row?.payment_status || row?.request_status);

  if (!status) return true;

  const badStatuses = [
    "pending",
    "created",
    "waiting",
    "wait",
    "processing",
    "в ожидании",
    "ожидает",
    "создано",
    "cancelled",
    "canceled",
    "rejected",
    "failed",
    "declined",
    "отменено",
    "отклонено",
    "ошибка",
  ];

  if (badStatuses.some((item) => status.includes(item))) return false;

  const goodStatuses = [
    "success",
    "succeeded",
    "completed",
    "complete",
    "paid",
    "approved",
    "confirmed",
    "done",
    "accepted",
    "успешно",
    "выполнено",
    "оплачено",
    "одобрено",
    "подтверждено",
  ];

  return goodStatuses.some((item) => status.includes(item));

}

function rowAmount(row: any) {

  return Math.abs(pickNumber(row, [
    "amount",
    "sum",
    "value",
    "rub_amount",
    "amount_rub",
    "amountRub",
    "total",
    "balance_change",
    "balanceChange",
  ], 0));

}

function rowKind(row: any, fallbackKind: "deposit" | "withdraw" | "mixed") {

  if (fallbackKind === "deposit" || fallbackKind === "withdraw") return fallbackKind;

  const text = lowerText([
    row?.type,
    row?.kind,
    row?.direction,
    row?.operation,
    row?.category,
    row?.title,
    row?.source,
  ].join(" "));

  if (text.includes("deposit") || text.includes("topup") || text.includes("replenish") || text.includes("пополн")) {

    return "deposit";

  }

  if (text.includes("withdraw") || text.includes("withdrawal") || text.includes("cashout") || text.includes("вывод")) {

    return "withdraw";

  }

  return "mixed";

}

async function sumFinancialRowsByTable(
  supabase: any,
  userId: string,
  tableName: string,
  fallbackKind: "deposit" | "withdraw" | "mixed",
) {

  const userColumns = ["user_id", "userId", "player_id", "owner_id", "account_id"];

  for (const userColumn of userColumns) {

    try {

      const { data, error } = await supabase
        .from(tableName)
        .select("*")
        .eq(userColumn, userId)
        .limit(1000);

      if (error) continue;

      if (!Array.isArray(data)) continue;

      let deposits = 0;
      let withdrawals = 0;

      for (const row of data) {

        if (!isFinalMoneyStatus(row)) continue;

        const amount = rowAmount(row);

        if (amount <= 0) continue;

        const kind = rowKind(row, fallbackKind);

        if (kind === "deposit") deposits += amount;
        if (kind === "withdraw") withdrawals += amount;

      }

      return { deposits, withdrawals, matched: true, tableName, userColumn };

    } catch (_error) {

      continue;

    }

  }

  return { deposits: 0, withdrawals: 0, matched: false, tableName, userColumn: "" };

}

async function getFinancialTotals(supabase: any, userId: string, playData: any) {

  const dataDeposits = pickNumber(playData, [
    "totalDeposits",
    "total_deposits",
    "deposits_total",
    "deposit_total",
    "totalDepositAmount",
  ], 0);

  const dataWithdrawals = pickNumber(playData, [
    "totalWithdrawals",
    "total_withdrawals",
    "withdrawals_total",
    "withdraw_total",
    "totalWithdrawalAmount",
  ], 0);

  if (dataDeposits > 0 || dataWithdrawals > 0) {

    return { totalDeposits: dataDeposits, totalWithdrawals: dataWithdrawals, source: "rpc_response" };

  }

  const tables: Array<{ name: string; kind: "deposit" | "withdraw" | "mixed" }> = [
    { name: "Deposit", kind: "deposit" },
    { name: "Deposits", kind: "deposit" },
    { name: "Payment", kind: "deposit" },
    { name: "Payments", kind: "deposit" },
    { name: "PaymentRequest", kind: "deposit" },
    { name: "DepositRequest", kind: "deposit" },
    { name: "Withdraw", kind: "withdraw" },
    { name: "Withdrawal", kind: "withdraw" },
    { name: "Withdrawals", kind: "withdraw" },
    { name: "WithdrawRequest", kind: "withdraw" },
    { name: "WithdrawalRequest", kind: "withdraw" },
    { name: "WalletTransaction", kind: "mixed" },
    { name: "WalletTransactions", kind: "mixed" },
    { name: "Transaction", kind: "mixed" },
    { name: "Transactions", kind: "mixed" },
    { name: "PaymentHistory", kind: "mixed" },
    { name: "FinanceHistory", kind: "mixed" },
  ];

  let totalDeposits = 0;
  let totalWithdrawals = 0;
  const matchedSources: string[] = [];

  for (const table of tables) {

    const result = await sumFinancialRowsByTable(supabase, userId, table.name, table.kind);

    if (!result.matched) continue;

    if (result.deposits > 0 || result.withdrawals > 0) {

      totalDeposits += result.deposits;
      totalWithdrawals += result.withdrawals;
      matchedSources.push(`${result.tableName}.${result.userColumn}`);

    }

  }

  return { totalDeposits, totalWithdrawals, source: matchedSources.join(",") || "not_found" };

}

async function getCurrentBalanceAfterPlay(supabase: any, userId: string, playData: any) {

  const fromData = pickNumber(playData, [
    "balance",
    "newBalance",
    "new_balance",
    "currentBalance",
    "current_balance",
    "balance_after",
    "afterBalance",
  ], Number.NaN);

  if (Number.isFinite(fromData)) return Math.max(0, fromData);

  const { data, error } = await supabase
    .from("Balance")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  return Math.max(0, safeNumber(data?.balance, 0));

}

async function getPartnerSnapshot(supabase: any, userId: string) {

  const { data, error } = await supabase
    .from("User")
    .select("id, invited_by_user_id, partner_net_loss_baseline, partner_rewarded_loss")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;

  return data || null;

}

function detectCoinflipLoss(playData: any, bet: number) {

  const explicitIsWin = playData?.is_win ?? playData?.isWin ?? playData?.win ?? playData?.won;

  if (explicitIsWin === true) return { isLoss: false, lossAmount: 0 };
  if (explicitIsWin === false) return { isLoss: true, lossAmount: bet };

  const resultText = lowerText([
    playData?.result,
    playData?.status,
    playData?.outcome,
    playData?.message,
  ].join(" "));

  if (resultText.includes("lose") || resultText.includes("loss") || resultText.includes("проиг")) {

    return { isLoss: true, lossAmount: bet };

  }

  if (resultText.includes("win") || resultText.includes("won") || resultText.includes("выиг")) {

    return { isLoss: false, lossAmount: 0 };

  }

  const payout = pickNumber(playData, ["payout", "win_amount", "winAmount", "reward", "prize"], Number.NaN);

  if (Number.isFinite(payout)) {

    return payout <= 0 ? { isLoss: true, lossAmount: bet } : { isLoss: false, lossAmount: 0 };

  }

  const profit = pickNumber(playData, ["profit", "net_profit", "netProfit"], Number.NaN);

  if (Number.isFinite(profit)) {

    return profit < 0 ? { isLoss: true, lossAmount: Math.abs(profit) } : { isLoss: false, lossAmount: 0 };

  }

  return { isLoss: false, lossAmount: 0 };

}

async function syncPartnerCommissionAfterCoinflip(supabase: any, userId: string, bet: number, playData: any) {

  try {

    const referral = await getPartnerSnapshot(supabase, userId);

    if (!referral?.invited_by_user_id) {

      return;

    }

    const currentBalance = await getCurrentBalanceAfterPlay(supabase, userId, playData);
    const totals = await getFinancialTotals(supabase, userId, playData);

    let totalDeposits = totals.totalDeposits;
    let totalWithdrawals = totals.totalWithdrawals;
    let totalsSource = totals.source;

    // ВАЖНО: не делаем искусственный fallback по ставке.
    // Партнёрка должна считать только по реальным подтверждённым пополнениям/выводам.
    // Иначе можно случайно зачесть старый баланс или старую историю игрока.
    if (totalDeposits <= 0 && totalWithdrawals <= 0) {

      console.log("[coinflip] partner skipped: no approved finance totals found");
      return;

    }

    const { data, error } = await supabase.rpc("create_partner_pending_earning", {

      p_referral_user_id: String(userId),
      p_total_deposits: totalDeposits,
      p_total_withdrawals: totalWithdrawals,
      p_current_balance: currentBalance,
      p_meta: {
        source: "coinflip",
        game: "coinflip",
        bet_amount: bet,
        finance_source: totalsSource,
        play_result: playData,
      },

    });

    if (error) {

      console.error("[coinflip] partner commission rpc error:", error);
      return;

    }

    console.log("[coinflip] partner commission result:", data);

  } catch (error) {

    console.error("[coinflip] partner commission sync failed:", error);

  }

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

  console.log("[coinflip]", req.method, new Date().toISOString());

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

      auth: {

        persistSession: false,

      },

    });

    const dbUser = await findUserByTelegramId(supabase, Number(telegramUser.id));

    if (action === "state") {

      const { data, error } = await supabase.rpc("coinflip_get_state", {

        p_user_id: dbUser.id,

        p_telegram_id: Number(telegramUser.id),

      });

      if (error) {

        console.error("[coinflip] state rpc error:", error);

        throw new Error(error.message || JSON.stringify(error));

      }

      return json({

        ok: true,

        ...data,

      });

    }

    if (action === "play") {

      const choice = normalizeChoice(body.choice);

      const bet = normalizeBet(body.bet);

      const { data, error } = await supabase.rpc("coinflip_play", {

        p_user_id: dbUser.id,

        p_telegram_id: Number(telegramUser.id),

        p_choice: choice,

        p_bet_amount: bet,

      });

      if (error) {

        console.error("[coinflip] play rpc error:", error);

        throw new Error(error.message || JSON.stringify(error));

      }

      await syncPartnerCommissionAfterCoinflip(supabase, dbUser.id, bet, data);

      return json({

        ok: true,

        ...data,

      });

    }

    throw new Error("Unknown action");

  } catch (error) {

    console.error("[coinflip] REAL ERROR:", error);

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