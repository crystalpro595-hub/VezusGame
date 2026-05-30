import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {

  "Access-Control-Allow-Origin": "*",

  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",

  "Access-Control-Allow-Methods": "POST, OPTIONS",

};

const ADMIN_TOKEN_TTL_SECONDS = 60 * 60 * 12;

const PAGE_SIZE = 1000;

function json(body: unknown, status = 200) {

  return new Response(JSON.stringify(body), {

    status,

    headers: {

      ...corsHeaders,

      "Content-Type": "application/json",

    },

  });

}

function timingSafeEqual(a: string, b: string) {

  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {

    result |= a.charCodeAt(i) ^ b.charCodeAt(i);

  }

  return result === 0;

}

function getCleanText(value: unknown) {

  return String(value || "").trim();

}

function getAmount(value: unknown) {

  const amount = Number(value);

  if (!Number.isFinite(amount)) {

    throw new Error("Некорректная сумма");

  }

  return Math.floor(amount);

}

function getPositiveInt(value: unknown, label: string) {

  const number = Math.floor(Number(value));

  if (!Number.isFinite(number) || number < 1) {

    throw new Error(`${label} должно быть больше 0`);

  }

  return number;

}

function getUuid(value: unknown, label: string) {

  const id = getCleanText(value);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {

    throw new Error(`Invalid ${label}`);

  }

  return id;

}

function getTransactionId(value: unknown) {

  return getUuid(value, "transaction id");

}

function getUserId(value: unknown) {

  return getUuid(value, "user id");

}

function getVoucherId(value: unknown) {

  return getUuid(value, "voucher id");

}

function base64UrlEncode(value: string) {

  return btoa(value)

    .replaceAll("+", "-")

    .replaceAll("/", "_")

    .replaceAll("=", "");

}

function base64UrlDecode(value: string) {

  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");

  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);

  return atob(padded);

}

async function hmacSha256Hex(key: string, data: string) {

  const cryptoKey = await crypto.subtle.importKey(

    "raw",

    new TextEncoder().encode(key),

    { name: "HMAC", hash: "SHA-256" },

    false,

    ["sign"],

  );

  const signature = new Uint8Array(

    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)),

  );

  return [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");

}

async function createAdminToken() {

  const secret = Deno.env.get("ADMIN_SESSION_SECRET");

  if (!secret) {

    throw new Error("ADMIN_SESSION_SECRET is not configured");

  }

  const now = Math.floor(Date.now() / 1000);

  const payload = {

    role: "admin",

    iat: now,

    exp: now + ADMIN_TOKEN_TTL_SECONDS,

    nonce: crypto.randomUUID(),

  };

  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));

  const signature = await hmacSha256Hex(secret, payloadEncoded);

  return `${payloadEncoded}.${signature}`;

}

async function verifyAdminToken(token: string) {

  const secret = Deno.env.get("ADMIN_SESSION_SECRET");

  if (!secret) {

    throw new Error("ADMIN_SESSION_SECRET is not configured");

  }

  if (!token || !token.includes(".")) {

    throw new Error("Admin token is missing");

  }

  const [payloadEncoded, signature] = token.split(".");

  const expectedSignature = await hmacSha256Hex(secret, payloadEncoded);

  if (!timingSafeEqual(signature, expectedSignature)) {

    throw new Error("Invalid admin token");

  }

  const payload = JSON.parse(base64UrlDecode(payloadEncoded));

  if (payload.role !== "admin") {

    throw new Error("Invalid admin role");

  }

  if (!payload.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) {

    throw new Error("Admin token expired");

  }

  return payload;

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

async function handleLogin(body: any) {

  const password = String(body.password || "");

  const adminPassword = Deno.env.get("ADMIN_PASSWORD");

  if (!adminPassword) {

    return json({ error: "ADMIN_PASSWORD is not configured" }, 500);

  }

  if (!timingSafeEqual(password, adminPassword)) {

    return json({ error: "Неверный пароль" }, 403);

  }

  const token = await createAdminToken();

  return json({

    ok: true,

    token,

    expires_in: ADMIN_TOKEN_TTL_SECONDS,

  });

}

async function selectAll(

  supabase: any,

  table: string,

  columns: string,

  orderColumn?: string,

) {

  const result: any[] = [];

  let from = 0;

  while (true) {

    let query = supabase

      .from(table)

      .select(columns)

      .range(from, from + PAGE_SIZE - 1);

    if (orderColumn) {

      query = query.order(orderColumn, { ascending: false });

    }

    const { data, error } = await query;

    if (error) throw error;

    const rows = data || [];

    result.push(...rows);

    if (rows.length < PAGE_SIZE) break;

    from += PAGE_SIZE;

    if (from > 50000) break;

  }

  return result;

}

async function getUsersPayload(supabase: any) {

  const users = await selectAll(

    supabase,

    "User",

    "id, telegram_id, username, first_name, last_name, photo_url, language_code, is_premium, created_at, updated_at",

    "created_at",

  );

  const balances = await selectAll(

    supabase,

    "Balance",

    "user_id, telegram_id, balance, currency, updated_at",

  );

  const balancesByUserId = Object.fromEntries(

    balances.map((balance) => [String(balance.user_id), balance]),

  );

  const items = users.map((user: any) => {

    const balance = balancesByUserId[String(user.id)] || null;

    return {

      ...user,

      balance: balance ? Number(balance.balance || 0) : 0,

      currency: balance?.currency || "RUB",

      balance_updated_at: balance?.updated_at || null,

    };

  });

  const totalBalance = items.reduce((sum: number, user: any) => {

    return sum + Number(user.balance || 0);

  }, 0);

  return {

    users_total: items.length,

    users: items,

    users_balance_total: totalBalance,

  };

}

async function getTransactionsPayload(supabase: any) {

  const transactions = await selectAll(

    supabase,

    "Transaction",

    "id, user_id, telegram_id, type, status, amount, currency, method, sender_fio, recipient_fio, recipient_bank, balance_before, balance_after, comment, created_at, updated_at",

    "created_at",

  );

  const safeTransactions = transactions || [];

  const userIds = [

    ...new Set(safeTransactions.map((item: any) => item.user_id).filter(Boolean)),

  ];

  let users: any[] = [];

  let balances: any[] = [];

  if (userIds.length) {

    const { data: usersData, error: usersError } = await supabase

      .from("User")

      .select("id, telegram_id, username, first_name, last_name, photo_url, created_at")

      .in("id", userIds);

    if (usersError) throw usersError;

    users = usersData || [];

    const { data: balancesData, error: balancesError } = await supabase

      .from("Balance")

      .select("user_id, telegram_id, balance, currency, updated_at")

      .in("user_id", userIds);

    if (balancesError) throw balancesError;

    balances = balancesData || [];

  }

  const usersById = Object.fromEntries(users.map((user) => [String(user.id), user]));

  const balancesByUserId = Object.fromEntries(

    balances.map((balance) => [String(balance.user_id), balance]),

  );

  const items = safeTransactions.map((tx: any) => {

    const key = String(tx.user_id);

    return {

      ...tx,

      user: usersById[key] || null,

      current_balance: balancesByUserId[key]?.balance ?? null,

    };

  });

  const pending = items.filter((item: any) => item.status === "pending");

  const pendingDeposits = pending.filter((item: any) => item.type === "deposit");

  const pendingWithdraws = pending.filter((item: any) => item.type === "withdraw");

  const approvedDeposits = items.filter(

    (item: any) => item.type === "deposit" && item.status === "approved",

  );

  const approvedWithdraws = items.filter(

    (item: any) => item.type === "withdraw" && item.status === "approved",

  );

  const sumAmount = (list: any[]) => {

    return list.reduce((sum, item) => sum + Number(item.amount || 0), 0);

  };

  return {

    transactions_stats: {

      total: items.length,

      pending: pending.length,

      pending_deposits: pendingDeposits.length,

      pending_withdraws: pendingWithdraws.length,

      pending_deposit_amount: sumAmount(pendingDeposits),

      pending_withdraw_amount: sumAmount(pendingWithdraws),

      total_deposit_amount: sumAmount(approvedDeposits),

      total_withdraw_amount: sumAmount(approvedWithdraws),

    },

    transactions: items.slice(0, 500),

  };

}

async function getVouchersPayload(supabase: any) {

  const vouchers = await selectAll(

    supabase,

    "Voucher",

    "id, code, amount, max_uses, used_count, is_active, comment, expires_at, created_at, updated_at",

    "created_at",

  );

  const voucherIds = vouchers.map((item: any) => item.id).filter(Boolean);

  let redeems: any[] = [];

  if (voucherIds.length) {

    const { data, error } = await supabase

      .from("VoucherRedeem")

      .select("id, voucher_id, user_id, telegram_id, code, amount, created_at")

      .in("voucher_id", voucherIds)

      .order("created_at", { ascending: false })

      .limit(1000);

    if (error) throw error;

    redeems = data || [];

  }

  const redeemUserIds = [

    ...new Set(redeems.map((item: any) => item.user_id).filter(Boolean)),

  ];

  let redeemUsers: any[] = [];

  if (redeemUserIds.length) {

    const { data, error } = await supabase

      .from("User")

      .select("id, telegram_id, username, first_name, last_name, photo_url")

      .in("id", redeemUserIds);

    if (error) throw error;

    redeemUsers = data || [];

  }

  const usersById = Object.fromEntries(

    redeemUsers.map((user) => [String(user.id), user]),

  );

  const redeemsByVoucherId = redeems.reduce((acc: any, item: any) => {

    const key = String(item.voucher_id);

    if (!acc[key]) acc[key] = [];

    acc[key].push({

      ...item,

      user: usersById[String(item.user_id)] || null,

    });

    return acc;

  }, {});

  const items = vouchers.map((voucher: any) => ({

    ...voucher,

    amount: Number(voucher.amount || 0),

    max_uses: Number(voucher.max_uses || 0),

    used_count: Number(voucher.used_count || 0),

    redeems: redeemsByVoucherId[String(voucher.id)] || [],

  }));

  return {

    vouchers: items,

    vouchers_stats: {

      vouchers_total: items.length,

      vouchers_active: items.filter((v: any) => v.is_active).length,

      vouchers_used_total: items.reduce((sum: number, v: any) => {

        return sum + Number(v.used_count || 0);

      }, 0),

      vouchers_amount_issued: items.reduce((sum: number, v: any) => {

        return sum + Number(v.amount || 0) * Number(v.used_count || 0);

      }, 0),

    },

  };

}

async function getGamesPayload(supabase: any) {

  const { data, error } = await supabase

    .from("GameSetting")

    .select(

      "id, game_key, title, is_active, win_chance, multiplier, min_bet, max_bet, created_at, updated_at",

    )

    .order("created_at", { ascending: true });

  if (error) throw error;

  return {

    games: (data || []).map((game: any) => ({

      ...game,

      win_chance: Number(game.win_chance || 0),

      multiplier: Number(game.multiplier || 0),

      min_bet: Number(game.min_bet || 0),

      max_bet: Number(game.max_bet || 0),

    })),

  };

}


async function safeSelectAll(
  supabase: any,
  table: string,
  columns: string,
  orderColumn?: string,
) {
  try {
    return await selectAll(supabase, table, columns, orderColumn);
  } catch (error) {
    console.warn(`[admin-wallet] optional table skipped: ${table}`, error);
    return [];
  }
}

function asMoneyNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function asPercent(value: unknown) {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("Процент партнёра должен быть от 0 до 100");
  }
  return percent;
}

function getPartnerEarningId(value: unknown) {
  return getUuid(value, "partner earning id");
}

function getPartnerPayoutId(value: unknown) {
  return getUuid(value, "partner payout id");
}

async function getPartnerPayload(supabase: any) {
  const partnerUsers = await selectAll(
    supabase,
    "User",
    "id, telegram_id, username, first_name, last_name, photo_url, referral_code, invited_by_user_id, partner_code_used, partner_bound_at, partner_net_loss_baseline, partner_rewarded_loss, partner_percent, partner_pending_balance, partner_balance, is_partner_active, created_at, updated_at",
    "created_at",
  );

  const referrals = await safeSelectAll(
    supabase,
    "PartnerReferral",
    "id, partner_user_id, referral_user_id, referral_code, created_at",
    "created_at",
  );

  const earnings = await safeSelectAll(
    supabase,
    "PartnerEarning",
    "id, partner_user_id, referral_user_id, base_loss_amount, commission_amount, percent, status, meta, created_at, updated_at",
    "created_at",
  );

  const payoutRequests = await safeSelectAll(
    supabase,
    "PartnerPayoutRequest",
    "id, partner_user_id, amount, method, requisites, status, admin_comment, created_at, approved_at, paid_at, rejected_at, updated_at",
    "created_at",
  );

  const userIds = [
    ...new Set([
      ...partnerUsers.map((u: any) => u.id),
      ...referrals.map((r: any) => r.partner_user_id),
      ...referrals.map((r: any) => r.referral_user_id),
      ...earnings.map((e: any) => e.partner_user_id),
      ...earnings.map((e: any) => e.referral_user_id),
      ...payoutRequests.map((p: any) => p.partner_user_id),
    ].filter(Boolean).map(String)),
  ];

  let users: any[] = [];

  if (userIds.length) {
    const { data, error } = await supabase
      .from("User")
      .select("id, telegram_id, username, first_name, last_name, photo_url, referral_code, invited_by_user_id, partner_code_used, partner_bound_at, partner_percent, partner_pending_balance, partner_balance, is_partner_active, created_at")
      .in("id", userIds);

    if (error) throw error;
    users = data || [];
  }

  const usersById = Object.fromEntries(users.map((user: any) => [String(user.id), user]));

  const referralCounts: Record<string, number> = {};
  for (const referral of referrals) {
    const partnerId = String(referral.partner_user_id || "");
    if (!partnerId) continue;
    referralCounts[partnerId] = (referralCounts[partnerId] || 0) + 1;
  }

  const earningTotalsByPartner: Record<string, any> = {};
  for (const earning of earnings) {
    const partnerId = String(earning.partner_user_id || "");
    if (!partnerId) continue;
    if (!earningTotalsByPartner[partnerId]) {
      earningTotalsByPartner[partnerId] = { pending: 0, available: 0, paid: 0, cancelled: 0, total: 0 };
    }
    const amount = asMoneyNumber(earning.commission_amount);
    const status = String(earning.status || "pending");
    earningTotalsByPartner[partnerId].total += amount;
    if (status === "pending") earningTotalsByPartner[partnerId].pending += amount;
    else if (status === "available") earningTotalsByPartner[partnerId].available += amount;
    else if (status === "paid") earningTotalsByPartner[partnerId].paid += amount;
    else if (status === "cancelled") earningTotalsByPartner[partnerId].cancelled += amount;
  }

  const partners = partnerUsers
    .filter((user: any) => {
      return Boolean(user.referral_code) ||
        asMoneyNumber(user.partner_balance) > 0 ||
        asMoneyNumber(user.partner_pending_balance) > 0 ||
        (referralCounts[String(user.id)] || 0) > 0 ||
        Boolean(earningTotalsByPartner[String(user.id)]);
    })
    .map((user: any) => ({
      ...user,
      referral_count: referralCounts[String(user.id)] || 0,
      earnings_totals: earningTotalsByPartner[String(user.id)] || { pending: 0, available: 0, paid: 0, cancelled: 0, total: 0 },
      partner_percent: asMoneyNumber(user.partner_percent || 10),
      partner_pending_balance: asMoneyNumber(user.partner_pending_balance),
      partner_balance: asMoneyNumber(user.partner_balance),
    }));

  const enrichedReferrals = referrals.map((referral: any) => ({
    ...referral,
    partner: usersById[String(referral.partner_user_id)] || null,
    referral: usersById[String(referral.referral_user_id)] || null,
  }));

  const enrichedEarnings = earnings.map((earning: any) => ({
    ...earning,
    partner: usersById[String(earning.partner_user_id)] || null,
    referral: usersById[String(earning.referral_user_id)] || null,
    base_loss_amount: asMoneyNumber(earning.base_loss_amount),
    commission_amount: asMoneyNumber(earning.commission_amount),
    percent: asMoneyNumber(earning.percent),
  }));

  const enrichedPayoutRequests = payoutRequests.map((request: any) => ({
    ...request,
    partner: usersById[String(request.partner_user_id)] || null,
    amount: asMoneyNumber(request.amount),
  }));

  const overview = {
    partners_total: partners.length,
    referrals_total: referrals.length,
    earnings_total: enrichedEarnings.reduce((sum: number, item: any) => sum + asMoneyNumber(item.commission_amount), 0),
    earnings_pending: enrichedEarnings.filter((item: any) => item.status === "pending").reduce((sum: number, item: any) => sum + asMoneyNumber(item.commission_amount), 0),
    earnings_available: enrichedEarnings.filter((item: any) => item.status === "available").reduce((sum: number, item: any) => sum + asMoneyNumber(item.commission_amount), 0),
    earnings_paid: enrichedEarnings.filter((item: any) => item.status === "paid").reduce((sum: number, item: any) => sum + asMoneyNumber(item.commission_amount), 0),
    payout_pending: enrichedPayoutRequests.filter((item: any) => item.status === "pending").reduce((sum: number, item: any) => sum + asMoneyNumber(item.amount), 0),
  };

  return {
    partner_overview: overview,
    partners,
    partner_referrals: enrichedReferrals.slice(0, 500),
    partner_earnings: enrichedEarnings.slice(0, 500),
    partner_payout_requests: enrichedPayoutRequests.slice(0, 500),
  };
}

async function approvePartnerPendingEarnings(supabase: any, body: any) {
  const partnerUserId = getUserId(body.partner_user_id);

  const { data: rows, error: selectError } = await supabase
    .from("PartnerEarning")
    .select("id, commission_amount")
    .eq("partner_user_id", partnerUserId)
    .eq("status", "pending");

  if (selectError) throw selectError;

  const amount = (rows || []).reduce((sum: number, item: any) => sum + asMoneyNumber(item.commission_amount), 0);

  if (amount <= 0) return;

  const { error: updateError } = await supabase
    .from("PartnerEarning")
    .update({ status: "available", updated_at: new Date().toISOString() })
    .eq("partner_user_id", partnerUserId)
    .eq("status", "pending");

  if (updateError) throw updateError;

  const { data: user, error: userError } = await supabase
    .from("User")
    .select("partner_pending_balance, partner_balance")
    .eq("id", partnerUserId)
    .maybeSingle();

  if (userError) throw userError;

  const pending = Math.max(0, asMoneyNumber(user?.partner_pending_balance) - amount);
  const available = asMoneyNumber(user?.partner_balance) + amount;

  const { error: balanceError } = await supabase
    .from("User")
    .update({
      partner_pending_balance: pending,
      partner_balance: available,
      updated_at: new Date().toISOString(),
    })
    .eq("id", partnerUserId);

  if (balanceError) throw balanceError;
}

async function cancelPartnerEarning(supabase: any, body: any) {
  const earningId = getPartnerEarningId(body.partner_earning_id);

  const { data: earning, error: selectError } = await supabase
    .from("PartnerEarning")
    .select("id, partner_user_id, commission_amount, status")
    .eq("id", earningId)
    .maybeSingle();

  if (selectError) throw selectError;
  if (!earning) throw new Error("Начисление не найдено");

  if (earning.status !== "pending") {
    throw new Error("Отменять можно только начисления в ожидании");
  }

  const { error: updateError } = await supabase
    .from("PartnerEarning")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", earningId);

  if (updateError) throw updateError;

  const { data: user, error: userError } = await supabase
    .from("User")
    .select("partner_pending_balance")
    .eq("id", earning.partner_user_id)
    .maybeSingle();

  if (userError) throw userError;

  const pending = Math.max(0, asMoneyNumber(user?.partner_pending_balance) - asMoneyNumber(earning.commission_amount));

  const { error: balanceError } = await supabase
    .from("User")
    .update({ partner_pending_balance: pending, updated_at: new Date().toISOString() })
    .eq("id", earning.partner_user_id);

  if (balanceError) throw balanceError;
}

async function markPartnerAvailableAsPaid(supabase: any, body: any) {
  const partnerUserId = getUserId(body.partner_user_id);

  const { data: rows, error: selectError } = await supabase
    .from("PartnerEarning")
    .select("id, commission_amount")
    .eq("partner_user_id", partnerUserId)
    .eq("status", "available");

  if (selectError) throw selectError;

  const amount = (rows || []).reduce((sum: number, item: any) => sum + asMoneyNumber(item.commission_amount), 0);

  if (amount <= 0) return;

  const { error: updateError } = await supabase
    .from("PartnerEarning")
    .update({ status: "paid", updated_at: new Date().toISOString() })
    .eq("partner_user_id", partnerUserId)
    .eq("status", "available");

  if (updateError) throw updateError;

  const { data: user, error: userError } = await supabase
    .from("User")
    .select("partner_balance")
    .eq("id", partnerUserId)
    .maybeSingle();

  if (userError) throw userError;

  const available = Math.max(0, asMoneyNumber(user?.partner_balance) - amount);

  const { error: balanceError } = await supabase
    .from("User")
    .update({ partner_balance: available, updated_at: new Date().toISOString() })
    .eq("id", partnerUserId);

  if (balanceError) throw balanceError;
}

async function updatePartnerPercent(supabase: any, body: any) {
  const partnerUserId = getUserId(body.partner_user_id);
  const percent = asPercent(body.percent);

  const { error } = await supabase
    .from("User")
    .update({ partner_percent: percent, updated_at: new Date().toISOString() })
    .eq("id", partnerUserId);

  if (error) throw error;
}

async function togglePartnerActive(supabase: any, body: any) {
  const partnerUserId = getUserId(body.partner_user_id);
  const isActive = Boolean(body.is_partner_active);

  const { error } = await supabase
    .from("User")
    .update({ is_partner_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", partnerUserId);

  if (error) throw error;
}

async function approvePartnerPayoutRequest(supabase: any, body: any) {
  const payoutId = getPartnerPayoutId(body.partner_payout_id);
  const comment = getCleanText(body.comment);

  const { error } = await supabase
    .from("PartnerPayoutRequest")
    .update({
      status: "approved",
      admin_comment: comment || null,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", payoutId)
    .eq("status", "pending");

  if (error) throw error;
}

async function rejectPartnerPayoutRequest(supabase: any, body: any) {
  const payoutId = getPartnerPayoutId(body.partner_payout_id);
  const comment = getCleanText(body.comment);

  const { error } = await supabase
    .from("PartnerPayoutRequest")
    .update({
      status: "rejected",
      admin_comment: comment || "Заявка отклонена администратором",
      rejected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", payoutId)
    .in("status", ["pending", "approved"]);

  if (error) throw error;
}

async function markPartnerPayoutPaid(supabase: any, body: any) {
  const payoutId = getPartnerPayoutId(body.partner_payout_id);
  const comment = getCleanText(body.comment);

  const { data: request, error: selectError } = await supabase
    .from("PartnerPayoutRequest")
    .select("id, partner_user_id, amount, status")
    .eq("id", payoutId)
    .maybeSingle();

  if (selectError) throw selectError;
  if (!request) throw new Error("Заявка на вывод не найдена");
  if (request.status === "paid") return;
  if (!["pending", "approved"].includes(String(request.status))) {
    throw new Error("Эту заявку нельзя отметить выплаченной");
  }

  const amount = asMoneyNumber(request.amount);

  const { data: user, error: userError } = await supabase
    .from("User")
    .select("partner_balance")
    .eq("id", request.partner_user_id)
    .maybeSingle();

  if (userError) throw userError;

  if (asMoneyNumber(user?.partner_balance) < amount) {
    throw new Error("Недостаточно доступного партнёрского баланса");
  }

  const { error: requestError } = await supabase
    .from("PartnerPayoutRequest")
    .update({
      status: "paid",
      admin_comment: comment || "Выплачено администратором",
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", payoutId);

  if (requestError) throw requestError;

  const { error: balanceError } = await supabase
    .from("User")
    .update({
      partner_balance: Math.max(0, asMoneyNumber(user?.partner_balance) - amount),
      updated_at: new Date().toISOString(),
    })
    .eq("id", request.partner_user_id);

  if (balanceError) throw balanceError;
}

async function updateGameSetting(supabase: any, body: any) {

  const gameKey = getCleanText(body.game_key);

  if (!gameKey) {

    throw new Error("Game key is required");

  }

  const patch: Record<string, unknown> = {

    updated_at: new Date().toISOString(),

  };

  if ("win_chance" in body) {

    const winChance = Number(body.win_chance);

    if (!Number.isFinite(winChance) || winChance < 0 || winChance > 100) {

      throw new Error("Шанс выигрыша должен быть от 0 до 100");

    }

    patch.win_chance = winChance;

  }

  if ("multiplier" in body) {

    const multiplier = Number(body.multiplier);

    if (!Number.isFinite(multiplier) || multiplier <= 1) {

      throw new Error("Коэффициент должен быть больше 1");

    }

    patch.multiplier = multiplier;

  }

  if ("min_bet" in body) {

    const minBet = Math.floor(Number(body.min_bet));

    if (!Number.isFinite(minBet) || minBet < 1) {

      throw new Error("Минимальная ставка должна быть больше 0");

    }

    patch.min_bet = minBet;

  }

  if ("max_bet" in body) {

    const maxBet = Math.floor(Number(body.max_bet));

    if (!Number.isFinite(maxBet) || maxBet < 1) {

      throw new Error("Максимальная ставка должна быть больше 0");

    }

    patch.max_bet = maxBet;

  }

  if ("is_active" in body) {

    patch.is_active = Boolean(body.is_active);

  }

  if (patch.min_bet !== undefined || patch.max_bet !== undefined) {

    const { data: current, error: currentError } = await supabase

      .from("GameSetting")

      .select("min_bet, max_bet")

      .eq("game_key", gameKey)

      .maybeSingle();

    if (currentError) throw currentError;

    if (!current) {

      throw new Error("Игра не найдена");

    }

    const finalMin = Number(patch.min_bet ?? current.min_bet);

    const finalMax = Number(patch.max_bet ?? current.max_bet);

    if (finalMax < finalMin) {

      throw new Error("Максимальная ставка должна быть больше минимальной");

    }

  }

  const { error } = await supabase

    .from("GameSetting")

    .update(patch)

    .eq("game_key", gameKey);

  if (error) throw error;

}

async function getAdminPayload(supabase: any) {

  const usersPayload = await getUsersPayload(supabase);

  const transactionsPayload = await getTransactionsPayload(supabase);

  const vouchersPayload = await getVouchersPayload(supabase);

  const gamesPayload = await getGamesPayload(supabase);

  const partnerPayload = await getPartnerPayload(supabase);

  return {

    stats: {

      users_total: usersPayload.users_total,

      users_balance_total: usersPayload.users_balance_total,

      ...transactionsPayload.transactions_stats,

      ...vouchersPayload.vouchers_stats,

      partner_pending_amount: partnerPayload.partner_overview.earnings_pending,

      partner_available_amount: partnerPayload.partner_overview.earnings_available,

    },

    users: usersPayload.users,

    transactions: transactionsPayload.transactions,

    vouchers: vouchersPayload.vouchers,

    games: gamesPayload.games,

    ...partnerPayload,

  };

}

async function runAction(supabase: any, action: string, body: any) {

  const comment = getCleanText(body.comment);

  if (action === "approve_deposit") {

    const transactionId = getTransactionId(body.transaction_id);

    const { error } = await supabase.rpc("approve_deposit_to_balance", {

      p_transaction_id: transactionId,

      p_comment: comment || "Пополнение подтверждено администратором",

    });

    if (error) throw error;

    return;

  }

  if (action === "decline_deposit") {

    const transactionId = getTransactionId(body.transaction_id);

    const { error } = await supabase.rpc("decline_deposit_transaction", {

      p_transaction_id: transactionId,

      p_comment: comment || "Пополнение отклонено администратором",

    });

    if (error) throw error;

    return;

  }

  if (action === "approve_withdraw") {

    const transactionId = getTransactionId(body.transaction_id);

    const { error } = await supabase.rpc("approve_withdraw_transaction", {

      p_transaction_id: transactionId,

      p_comment: comment || "Вывод подтвержден администратором",

    });

    if (error) throw error;

    return;

  }

  if (action === "decline_withdraw") {

    const transactionId = getTransactionId(body.transaction_id);

    const { error } = await supabase.rpc("return_withdraw_to_balance", {

      p_transaction_id: transactionId,

      p_new_status: "declined",

      p_comment: comment || "Вывод отклонен администратором, деньги возвращены на баланс",

    });

    if (error) throw error;

    return;

  }

  if (action === "set_balance") {

    const userId = getUserId(body.user_id);

    const balance = getAmount(body.balance);

    if (balance < 0) {

      throw new Error("Баланс не может быть меньше 0");

    }

    const { error } = await supabase.rpc("admin_set_user_balance", {

      p_user_id: userId,

      p_balance: balance,

      p_comment: comment || "Баланс изменён администратором",

    });

    if (error) throw error;

    return;

  }

  if (action === "delete_transaction") {

    const transactionId = getTransactionId(body.transaction_id);

    const { error } = await supabase

      .from("Transaction")

      .delete()

      .eq("id", transactionId);

    if (error) throw error;

    return;

  }

  if (action === "delete_user") {

    const userId = getUserId(body.user_id);

    const { error: txError } = await supabase

      .from("Transaction")

      .delete()

      .eq("user_id", userId);

    if (txError) throw txError;

    const { error: balanceError } = await supabase

      .from("Balance")

      .delete()

      .eq("user_id", userId);

    if (balanceError) throw balanceError;

    const { error: redeemError } = await supabase

      .from("VoucherRedeem")

      .delete()

      .eq("user_id", userId);

    if (redeemError) throw redeemError;

    const { error: userError } = await supabase

      .from("User")

      .delete()

      .eq("id", userId);

    if (userError) throw userError;

    return;

  }

  if (action === "create_voucher") {

    const code = getCleanText(body.code).toUpperCase();

    const amount = getAmount(body.amount);

    const maxUses = getPositiveInt(body.max_uses, "Количество использований");

    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {

      throw new Error("Код должен содержать 3–40 символов: латиница, цифры, _ или -");

    }

    if (amount < 1) {

      throw new Error("Сумма должна быть больше 0");

    }

    const { error } = await supabase.from("Voucher").insert({

      code,

      amount,

      max_uses: maxUses,

      used_count: 0,

      is_active: true,

      comment: comment || null,

    });

    if (error) {

      if (String(error.message || "").toLowerCase().includes("duplicate")) {

        throw new Error("Такой ваучер уже существует");

      }

      throw error;

    }

    return;

  }

  if (action === "toggle_voucher") {

    const voucherId = getVoucherId(body.voucher_id);

    const isActive = Boolean(body.is_active);

    const { error } = await supabase

      .from("Voucher")

      .update({

        is_active: isActive,

        updated_at: new Date().toISOString(),

      })

      .eq("id", voucherId);

    if (error) throw error;

    return;

  }

  if (action === "delete_voucher") {

    const voucherId = getVoucherId(body.voucher_id);

    const { error } = await supabase

      .from("Voucher")

      .delete()

      .eq("id", voucherId);

    if (error) throw error;

    return;

  }


  if (action === "approve_partner_earnings") {

    await approvePartnerPendingEarnings(supabase, body);

    return;

  }

  if (action === "cancel_partner_earning") {

    await cancelPartnerEarning(supabase, body);

    return;

  }

  if (action === "mark_partner_paid") {

    await markPartnerAvailableAsPaid(supabase, body);

    return;

  }

  if (action === "update_partner_percent") {

    await updatePartnerPercent(supabase, body);

    return;

  }

  if (action === "toggle_partner_active") {

    await togglePartnerActive(supabase, body);

    return;

  }

  if (action === "approve_partner_payout") {

    await approvePartnerPayoutRequest(supabase, body);

    return;

  }

  if (action === "reject_partner_payout") {

    await rejectPartnerPayoutRequest(supabase, body);

    return;

  }

  if (action === "mark_partner_payout_paid") {

    await markPartnerPayoutPaid(supabase, body);

    return;

  }

  if (action === "update_game_setting") {

    await updateGameSetting(supabase, body);

    return;

  }

  throw new Error("Unknown admin action");

}

Deno.serve(async (req) => {

  console.log("[admin-wallet]", req.method, new Date().toISOString());

  if (req.method === "OPTIONS") {

    return new Response("ok", { headers: corsHeaders });

  }

  if (req.method !== "POST") {

    return json({ error: "Method not allowed" }, 405);

  }

  try {

    const body = await req.json();

    const action = String(body.action || "get");

    if (action === "login") {

      return await handleLogin(body);

    }

    const token = String(body.token || "");

    await verifyAdminToken(token);

    const { supabaseUrl, serviceRoleKey } = requireServerEnv();

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    if (action !== "get") {

      await runAction(supabase, action, body);

    }

    const payload = await getAdminPayload(supabase);

    return json({ ok: true, ...payload });

  } catch (error) {

    console.error("[admin-wallet] error", error);

    return json(

      { error: error instanceof Error ? error.message : "Unknown error" },

      400,

    );

  }

});