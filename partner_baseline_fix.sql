-- VezusGame Partner Program — SAFE BASELINE FIX
-- Исправляет баг, когда партнёрка цепляла старые пополнения/проигрыши до активации промокода.
-- Запускать один раз в Supabase SQL Editor.

begin;

-- 1) Добавляем точные снимки на момент активации промокода.
alter table public."User"
  add column if not exists partner_deposits_baseline numeric(14,2) not null default 0,
  add column if not exists partner_withdrawals_baseline numeric(14,2) not null default 0,
  add column if not exists partner_balance_baseline numeric(14,2) not null default 0;

alter table public."PartnerReferral"
  add column if not exists deposits_baseline numeric(14,2) not null default 0,
  add column if not exists withdrawals_baseline numeric(14,2) not null default 0,
  add column if not exists balance_baseline numeric(14,2) not null default 0;

-- 2) Для старых привязок делаем безопасный backfill.
-- Важно: для уже активированных кодов точный старый баланс не всегда можно восстановить,
-- поэтому дальше лучше отменить ошибочные начисления вручную и проверить старые связки.
update public."User" u
set
  partner_deposits_baseline = coalesce(u.partner_deposits_baseline, 0),
  partner_withdrawals_baseline = coalesce(u.partner_withdrawals_baseline, 0),
  partner_balance_baseline = coalesce(u.partner_balance_baseline, 0)
where u.invited_by_user_id is not null;

-- 3) Новая безопасная активация промокода.
-- Теперь сохраняем не только net_loss_baseline, но и точные снимки:
-- deposits_at_bind / withdrawals_at_bind / balance_at_bind.
create or replace function public.activate_partner_promo_code(
  p_user_id text,
  p_code text,
  p_total_deposits numeric default 0,
  p_total_withdrawals numeric default 0,
  p_current_balance numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_code text;
  current_user_row record;
  partner_row record;
  baseline_net_loss numeric(14,2);
  baseline_deposits numeric(14,2);
  baseline_withdrawals numeric(14,2);
  baseline_balance numeric(14,2);
begin
  clean_code := upper(btrim(coalesce(p_code, '')));

  if clean_code = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty_code', 'message', 'Введите промокод партнёра');
  end if;

  select * into current_user_row
  from public."User"
  where id::text = p_user_id
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'user_not_found', 'message', 'Пользователь не найден');
  end if;

  if current_user_row.invited_by_user_id is not null or current_user_row.partner_code_used is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_bound', 'message', 'Вы уже привязаны к партнёру');
  end if;

  select * into partner_row
  from public."User"
  where lower(referral_code) = lower(clean_code)
    and coalesce(is_partner_active, true) = true
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'code_not_found', 'message', 'Промокод не найден');
  end if;

  if partner_row.id::text = current_user_row.id::text then
    return jsonb_build_object('ok', false, 'reason', 'self_referral', 'message', 'Нельзя активировать свой промокод');
  end if;

  baseline_deposits := greatest(0, coalesce(p_total_deposits, 0));
  baseline_withdrawals := greatest(0, coalesce(p_total_withdrawals, 0));
  baseline_balance := greatest(0, coalesce(p_current_balance, 0));
  baseline_net_loss := greatest(0, baseline_deposits - baseline_withdrawals - baseline_balance);

  update public."User"
  set
    invited_by_user_id = partner_row.id,
    partner_code_used = partner_row.referral_code,
    partner_bound_at = now(),
    partner_net_loss_baseline = baseline_net_loss,
    partner_deposits_baseline = baseline_deposits,
    partner_withdrawals_baseline = baseline_withdrawals,
    partner_balance_baseline = baseline_balance,
    partner_rewarded_loss = 0
  where id::text = current_user_row.id::text;

  insert into public."PartnerReferral" (
    partner_user_id,
    referral_user_id,
    referral_code,
    net_loss_baseline,
    deposits_baseline,
    withdrawals_baseline,
    balance_baseline
  ) values (
    partner_row.id,
    current_user_row.id,
    partner_row.referral_code,
    baseline_net_loss,
    baseline_deposits,
    baseline_withdrawals,
    baseline_balance
  )
  on conflict (referral_user_id) do update
  set
    partner_user_id = excluded.partner_user_id,
    referral_code = excluded.referral_code,
    net_loss_baseline = excluded.net_loss_baseline,
    deposits_baseline = excluded.deposits_baseline,
    withdrawals_baseline = excluded.withdrawals_baseline,
    balance_baseline = excluded.balance_baseline;

  return jsonb_build_object(
    'ok', true,
    'message', 'Промокод активирован',
    'partner_user_id', partner_row.id,
    'referral_code', partner_row.referral_code,
    'net_loss_baseline', baseline_net_loss,
    'deposits_baseline', baseline_deposits,
    'withdrawals_baseline', baseline_withdrawals,
    'balance_baseline', baseline_balance
  );
end;
$$;

-- 4) Новый preview: считает ТОЛЬКО после активации промокода.
-- Формула:
-- deposits_after = total_deposits - deposits_baseline
-- withdrawals_after = total_withdrawals - withdrawals_baseline
-- balance_from_new_money = max(current_balance - old_balance_at_bind, 0)
-- loss_after_bind = max(deposits_after - withdrawals_after - balance_from_new_money, 0)
create or replace function public.preview_partner_commission(
  p_referral_user_id text,
  p_total_deposits numeric default 0,
  p_total_withdrawals numeric default 0,
  p_current_balance numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  referral_row record;
  partner_row record;
  deposits_after_bind numeric(14,2);
  withdrawals_after_bind numeric(14,2);
  balance_from_new_money numeric(14,2);
  loss_after_bind numeric(14,2);
  rewardable_loss numeric(14,2);
  percent_value numeric(5,2);
  commission numeric(14,2);
begin
  select * into referral_row
  from public."User"
  where id::text = p_referral_user_id
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'referral_not_found');
  end if;

  if referral_row.invited_by_user_id is null then
    return jsonb_build_object('ok', true, 'has_partner', false, 'commission_amount', 0);
  end if;

  select * into partner_row
  from public."User"
  where id = referral_row.invited_by_user_id
  limit 1;

  if not found or coalesce(partner_row.is_partner_active, true) = false then
    return jsonb_build_object('ok', true, 'has_partner', false, 'reason', 'partner_inactive', 'commission_amount', 0);
  end if;

  deposits_after_bind := greatest(0, coalesce(p_total_deposits, 0) - coalesce(referral_row.partner_deposits_baseline, 0));
  withdrawals_after_bind := greatest(0, coalesce(p_total_withdrawals, 0) - coalesce(referral_row.partner_withdrawals_baseline, 0));
  balance_from_new_money := greatest(0, coalesce(p_current_balance, 0) - coalesce(referral_row.partner_balance_baseline, 0));

  loss_after_bind := greatest(0, deposits_after_bind - withdrawals_after_bind - balance_from_new_money);
  rewardable_loss := greatest(0, loss_after_bind - coalesce(referral_row.partner_rewarded_loss, 0));
  percent_value := coalesce(partner_row.partner_percent, 10);
  commission := round(rewardable_loss * percent_value / 100, 2);

  return jsonb_build_object(
    'ok', true,
    'has_partner', true,
    'partner_user_id', partner_row.id,
    'deposits_after_bind', deposits_after_bind,
    'withdrawals_after_bind', withdrawals_after_bind,
    'balance_from_new_money', balance_from_new_money,
    'loss_after_bind', loss_after_bind,
    'already_rewarded_loss', coalesce(referral_row.partner_rewarded_loss, 0),
    'rewardable_loss', rewardable_loss,
    'percent', percent_value,
    'commission_amount', commission,
    'baselines', jsonb_build_object(
      'deposits', coalesce(referral_row.partner_deposits_baseline, 0),
      'withdrawals', coalesce(referral_row.partner_withdrawals_baseline, 0),
      'balance', coalesce(referral_row.partner_balance_baseline, 0),
      'net_loss_legacy', coalesce(referral_row.partner_net_loss_baseline, 0)
    )
  );
end;
$$;

-- 5) Создание pending-начисления по новому preview.
create or replace function public.create_partner_pending_earning(
  p_referral_user_id text,
  p_total_deposits numeric default 0,
  p_total_withdrawals numeric default 0,
  p_current_balance numeric default 0,
  p_meta jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  preview jsonb;
  referral_row record;
  rewardable_loss numeric(14,2);
  commission numeric(14,2);
  percent_value numeric(5,2);
  earning_id uuid;
begin
  preview := public.preview_partner_commission(
    p_referral_user_id,
    p_total_deposits,
    p_total_withdrawals,
    p_current_balance
  );

  if coalesce((preview ->> 'has_partner')::boolean, false) = false then
    return jsonb_build_object('ok', true, 'created', false, 'reason', coalesce(preview ->> 'reason', 'no_partner'), 'preview', preview);
  end if;

  rewardable_loss := coalesce((preview ->> 'rewardable_loss')::numeric, 0);
  commission := coalesce((preview ->> 'commission_amount')::numeric, 0);
  percent_value := coalesce((preview ->> 'percent')::numeric, 10);

  if rewardable_loss <= 0 or commission <= 0 then
    return jsonb_build_object('ok', true, 'created', false, 'reason', 'nothing_to_reward', 'preview', preview);
  end if;

  select * into referral_row
  from public."User"
  where id::text = p_referral_user_id
  limit 1;

  insert into public."PartnerEarning" (
    partner_user_id,
    referral_user_id,
    base_loss_amount,
    commission_amount,
    percent,
    status,
    meta
  ) values (
    referral_row.invited_by_user_id,
    referral_row.id,
    rewardable_loss,
    commission,
    percent_value,
    'pending',
    coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('preview', preview, 'formula_version', 'safe_baseline_v2')
  )
  returning id into earning_id;

  update public."User"
  set partner_rewarded_loss = coalesce(partner_rewarded_loss, 0) + rewardable_loss
  where id::text = p_referral_user_id;

  update public."User"
  set partner_pending_balance = coalesce(partner_pending_balance, 0) + commission
  where id = referral_row.invited_by_user_id;

  return jsonb_build_object(
    'ok', true,
    'created', true,
    'earning_id', earning_id,
    'base_loss_amount', rewardable_loss,
    'commission_amount', commission,
    'status', 'pending',
    'preview', preview
  );
end;
$$;

notify pgrst, 'reload schema';

commit;
