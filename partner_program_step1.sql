-- VezusGame Partner Program — Step 1
-- Модель: промокод партнёра + 10% от чистого проигрыша после активации промокода.
-- Запускать в Supabase SQL Editor.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Генератор короткого партнёрского кода
CREATE OR REPLACE FUNCTION public.generate_partner_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i int;
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  END LOOP;

  RETURN result;
END;
$$;

-- 2) Добавляем поля в public."User".
-- Тип invited_by_user_id берём автоматически из типа public."User".id.
DO $$
DECLARE
  user_id_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
  INTO user_id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'public."User"'::regclass
    AND a.attname = 'id'
    AND NOT a.attisdropped;

  IF user_id_type IS NULL THEN
    RAISE EXCEPTION 'Не найдено поле id в public."User"';
  END IF;

  ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS referral_code text;
  EXECUTE format('ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS invited_by_user_id %s', user_id_type);
  ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS partner_code_used text;
  ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS partner_bound_at timestamptz;
  ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS partner_net_loss_baseline numeric(14,2) NOT NULL DEFAULT 0;
  ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS partner_rewarded_loss numeric(14,2) NOT NULL DEFAULT 0;
  ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS partner_percent numeric(5,2) NOT NULL DEFAULT 10;
  ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS partner_pending_balance numeric(14,2) NOT NULL DEFAULT 0;
  ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS partner_balance numeric(14,2) NOT NULL DEFAULT 0;
  ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS is_partner_active boolean NOT NULL DEFAULT true;

  BEGIN
    EXECUTE 'ALTER TABLE public."User" ADD CONSTRAINT user_invited_by_fk FOREIGN KEY (invited_by_user_id) REFERENCES public."User"(id) ON DELETE SET NULL';
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END $$;

-- 3) Заполняем партнёрские коды существующим пользователям без риска дублей
DO $$
DECLARE
  user_row record;
  code text;
BEGIN
  FOR user_row IN
    SELECT id
    FROM public."User"
    WHERE referral_code IS NULL OR btrim(referral_code) = ''
  LOOP
    LOOP
      code := public.generate_partner_code();
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public."User" u WHERE lower(u.referral_code) = lower(code)
      );
    END LOOP;

    UPDATE public."User"
    SET referral_code = code
    WHERE id = user_row.id;
  END LOOP;
END $$;

-- 4) Уникальность промокода без учёта регистра
CREATE UNIQUE INDEX IF NOT EXISTS user_referral_code_unique_lower
ON public."User" (lower(referral_code))
WHERE referral_code IS NOT NULL;

-- 5) Автогенерация referral_code для новых пользователей
CREATE OR REPLACE FUNCTION public.ensure_user_referral_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  code text;
BEGIN
  IF NEW.referral_code IS NULL OR btrim(NEW.referral_code) = '' THEN
    LOOP
      code := public.generate_partner_code();
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public."User" u WHERE lower(u.referral_code) = lower(code)
      );
    END LOOP;

    NEW.referral_code := code;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_user_referral_code'
      AND tgrelid = 'public."User"'::regclass
  ) THEN
    CREATE TRIGGER trg_user_referral_code
    BEFORE INSERT OR UPDATE OF referral_code ON public."User"
    FOR EACH ROW
    EXECUTE FUNCTION public.ensure_user_referral_code();
  END IF;
END $$;

-- 6) Таблица связки партнёр -> приглашённый игрок
DO $$
DECLARE
  user_id_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
  INTO user_id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'public."User"'::regclass
    AND a.attname = 'id'
    AND NOT a.attisdropped;

  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS public."PartnerReferral" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_user_id %1$s NOT NULL,
      referral_user_id %1$s NOT NULL UNIQUE,
      referral_code text NOT NULL,
      net_loss_baseline numeric(14,2) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  $sql$, user_id_type);

  BEGIN
    EXECUTE 'ALTER TABLE public."PartnerReferral" ADD CONSTRAINT partner_referral_partner_fk FOREIGN KEY (partner_user_id) REFERENCES public."User"(id) ON DELETE CASCADE';
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    EXECUTE 'ALTER TABLE public."PartnerReferral" ADD CONSTRAINT partner_referral_referral_fk FOREIGN KEY (referral_user_id) REFERENCES public."User"(id) ON DELETE CASCADE';
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

CREATE INDEX IF NOT EXISTS partner_referral_partner_idx
ON public."PartnerReferral" (partner_user_id);

-- 7) Таблица начислений партнёру
DO $$
DECLARE
  user_id_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
  INTO user_id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'public."User"'::regclass
    AND a.attname = 'id'
    AND NOT a.attisdropped;

  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS public."PartnerEarning" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_user_id %1$s NOT NULL,
      referral_user_id %1$s NOT NULL,
      base_loss_amount numeric(14,2) NOT NULL,
      commission_amount numeric(14,2) NOT NULL,
      percent numeric(5,2) NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'paid', 'cancelled')),
      source text NOT NULL DEFAULT 'net_loss',
      created_at timestamptz NOT NULL DEFAULT now(),
      available_at timestamptz,
      paid_at timestamptz,
      cancelled_at timestamptz,
      meta jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  $sql$, user_id_type);

  BEGIN
    EXECUTE 'ALTER TABLE public."PartnerEarning" ADD CONSTRAINT partner_earning_partner_fk FOREIGN KEY (partner_user_id) REFERENCES public."User"(id) ON DELETE CASCADE';
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    EXECUTE 'ALTER TABLE public."PartnerEarning" ADD CONSTRAINT partner_earning_referral_fk FOREIGN KEY (referral_user_id) REFERENCES public."User"(id) ON DELETE CASCADE';
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

CREATE INDEX IF NOT EXISTS partner_earning_partner_idx
ON public."PartnerEarning" (partner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS partner_earning_referral_idx
ON public."PartnerEarning" (referral_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS partner_earning_status_idx
ON public."PartnerEarning" (status);

-- 8) Активация промокода партнёра.
-- Важно: игрок может активировать только один партнёрский код.
-- Старые проигрыши до активации не учитываются: фиксируем baseline.
CREATE OR REPLACE FUNCTION public.activate_partner_promo_code(
  p_user_id text,
  p_code text,
  p_total_deposits numeric DEFAULT 0,
  p_total_withdrawals numeric DEFAULT 0,
  p_current_balance numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  clean_code text;
  current_user_row record;
  partner_row record;
  baseline numeric(14,2);
BEGIN
  clean_code := upper(btrim(coalesce(p_code, '')));

  IF clean_code = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_code', 'message', 'Введите промокод партнёра');
  END IF;

  SELECT * INTO current_user_row
  FROM public."User"
  WHERE id::text = p_user_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_not_found', 'message', 'Пользователь не найден');
  END IF;

  IF current_user_row.invited_by_user_id IS NOT NULL OR current_user_row.partner_code_used IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_bound', 'message', 'Вы уже привязаны к партнёру');
  END IF;

  SELECT * INTO partner_row
  FROM public."User"
  WHERE lower(referral_code) = lower(clean_code)
    AND is_partner_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'code_not_found', 'message', 'Промокод не найден');
  END IF;

  IF partner_row.id::text = current_user_row.id::text THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'self_referral', 'message', 'Нельзя активировать свой промокод');
  END IF;

  baseline := greatest(0, coalesce(p_total_deposits, 0) - coalesce(p_total_withdrawals, 0) - coalesce(p_current_balance, 0));

  UPDATE public."User"
  SET invited_by_user_id = partner_row.id,
      partner_code_used = partner_row.referral_code,
      partner_bound_at = now(),
      partner_net_loss_baseline = baseline,
      partner_rewarded_loss = 0
  WHERE id::text = current_user_row.id::text;

  INSERT INTO public."PartnerReferral" (
    partner_user_id,
    referral_user_id,
    referral_code,
    net_loss_baseline
  ) VALUES (
    partner_row.id,
    current_user_row.id,
    partner_row.referral_code,
    baseline
  )
  ON CONFLICT (referral_user_id) DO NOTHING;

  RETURN jsonb_build_object(
    'ok', true,
    'message', 'Промокод активирован',
    'partner_user_id', partner_row.id,
    'referral_code', partner_row.referral_code,
    'net_loss_baseline', baseline
  );
END;
$$;

-- 9) Предпросмотр комиссии без записи начисления.
CREATE OR REPLACE FUNCTION public.preview_partner_commission(
  p_referral_user_id text,
  p_total_deposits numeric DEFAULT 0,
  p_total_withdrawals numeric DEFAULT 0,
  p_current_balance numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  referral_row record;
  partner_row record;
  current_net_loss numeric(14,2);
  loss_after_bind numeric(14,2);
  rewardable_loss numeric(14,2);
  percent_value numeric(5,2);
  commission numeric(14,2);
BEGIN
  SELECT * INTO referral_row
  FROM public."User"
  WHERE id::text = p_referral_user_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'referral_not_found');
  END IF;

  IF referral_row.invited_by_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'has_partner', false, 'commission_amount', 0);
  END IF;

  SELECT * INTO partner_row
  FROM public."User"
  WHERE id = referral_row.invited_by_user_id
  LIMIT 1;

  current_net_loss := greatest(0, coalesce(p_total_deposits, 0) - coalesce(p_total_withdrawals, 0) - coalesce(p_current_balance, 0));
  loss_after_bind := greatest(0, current_net_loss - coalesce(referral_row.partner_net_loss_baseline, 0));
  rewardable_loss := greatest(0, loss_after_bind - coalesce(referral_row.partner_rewarded_loss, 0));
  percent_value := coalesce(partner_row.partner_percent, 10);
  commission := round(rewardable_loss * percent_value / 100, 2);

  RETURN jsonb_build_object(
    'ok', true,
    'has_partner', true,
    'partner_user_id', partner_row.id,
    'current_net_loss', current_net_loss,
    'baseline', coalesce(referral_row.partner_net_loss_baseline, 0),
    'already_rewarded_loss', coalesce(referral_row.partner_rewarded_loss, 0),
    'rewardable_loss', rewardable_loss,
    'percent', percent_value,
    'commission_amount', commission
  );
END;
$$;

-- 10) Создание pending-начисления.
-- Вызывать после завершения раунда / изменения баланса / подтверждённого пополнения или вывода.
-- Для безопасности начисление сначала pending, а не сразу доступно к выводу.
CREATE OR REPLACE FUNCTION public.create_partner_pending_earning(
  p_referral_user_id text,
  p_total_deposits numeric DEFAULT 0,
  p_total_withdrawals numeric DEFAULT 0,
  p_current_balance numeric DEFAULT 0,
  p_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  preview jsonb;
  referral_row record;
  partner_id text;
  rewardable_loss numeric(14,2);
  commission numeric(14,2);
  percent_value numeric(5,2);
  earning_id uuid;
BEGIN
  preview := public.preview_partner_commission(p_referral_user_id, p_total_deposits, p_total_withdrawals, p_current_balance);

  IF coalesce((preview ->> 'has_partner')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', true, 'created', false, 'reason', 'no_partner');
  END IF;

  rewardable_loss := coalesce((preview ->> 'rewardable_loss')::numeric, 0);
  commission := coalesce((preview ->> 'commission_amount')::numeric, 0);
  percent_value := coalesce((preview ->> 'percent')::numeric, 10);

  IF rewardable_loss <= 0 OR commission <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'created', false, 'reason', 'nothing_to_reward', 'preview', preview);
  END IF;

  SELECT * INTO referral_row
  FROM public."User"
  WHERE id::text = p_referral_user_id
  LIMIT 1;

  INSERT INTO public."PartnerEarning" (
    partner_user_id,
    referral_user_id,
    base_loss_amount,
    commission_amount,
    percent,
    status,
    meta
  ) VALUES (
    referral_row.invited_by_user_id,
    referral_row.id,
    rewardable_loss,
    commission,
    percent_value,
    'pending',
    coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('preview', preview)
  )
  RETURNING id INTO earning_id;

  UPDATE public."User"
  SET partner_rewarded_loss = partner_rewarded_loss + rewardable_loss
  WHERE id::text = p_referral_user_id;

  UPDATE public."User"
  SET partner_pending_balance = partner_pending_balance + commission
  WHERE id = referral_row.invited_by_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'created', true,
    'earning_id', earning_id,
    'base_loss_amount', rewardable_loss,
    'commission_amount', commission,
    'status', 'pending'
  );
END;
$$;

-- 11) Перевод pending-начисления в доступный баланс.
-- Это можно делать вручную из админки после проверки / холда.
CREATE OR REPLACE FUNCTION public.mark_partner_earning_available(p_earning_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  earning_row record;
BEGIN
  SELECT * INTO earning_row
  FROM public."PartnerEarning"
  WHERE id = p_earning_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'earning_not_found');
  END IF;

  IF earning_row.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_status', 'status', earning_row.status);
  END IF;

  UPDATE public."PartnerEarning"
  SET status = 'available',
      available_at = now()
  WHERE id = p_earning_id;

  UPDATE public."User"
  SET partner_pending_balance = greatest(0, partner_pending_balance - earning_row.commission_amount),
      partner_balance = partner_balance + earning_row.commission_amount
  WHERE id = earning_row.partner_user_id;

  RETURN jsonb_build_object('ok', true, 'status', 'available', 'amount', earning_row.commission_amount);
END;
$$;

COMMIT;
