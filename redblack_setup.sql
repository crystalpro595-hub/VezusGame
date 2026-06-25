-- Vezus Game: Red / Black setup
-- 1) Добавляет игру redblack в GameSetting
-- 2) Создаёт RPC функции redblack_get_state и redblack_play

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."GameSetting" WHERE game_key = 'redblack'
  ) THEN
    INSERT INTO public."GameSetting" (
      game_key,
      title,
      is_active,
      win_chance,
      multiplier,
      min_bet,
      max_bet
    ) VALUES (
      'redblack',
      'Red Black',
      true,
      40,
      2,
      8,
      10000
    );
  ELSE
    UPDATE public."GameSetting"
    SET
      title = COALESCE(NULLIF(title, ''), 'Red Black'),
      multiplier = CASE WHEN multiplier IS NULL OR multiplier <= 1 THEN 2 ELSE multiplier END,
      min_bet = CASE WHEN min_bet IS NULL OR min_bet < 1 THEN 8 ELSE min_bet END,
      max_bet = CASE WHEN max_bet IS NULL OR max_bet < min_bet THEN 10000 ELSE max_bet END,
      updated_at = now()
    WHERE game_key = 'redblack';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.redblack_get_state(
  p_user_id uuid,
  p_telegram_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_setting public."GameSetting"%ROWTYPE;
  v_balance numeric := 0;
  v_history jsonb := '[]'::jsonb;
BEGIN
  SELECT *
  INTO v_setting
  FROM public."GameSetting"
  WHERE game_key = 'redblack'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Настройки redblack не найдены';
  END IF;

  SELECT b.balance
  INTO v_balance
  FROM public."Balance" b
  WHERE b.user_id = p_user_id
  LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO public."Balance" (user_id, telegram_id, balance, currency)
    VALUES (p_user_id, p_telegram_id, 0, 'RUB');
    v_balance := 0;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'result', r.result,
        'choice', r.choice,
        'is_win', r.is_win,
        'bet_amount', r.bet_amount,
        'payout_amount', r.payout_amount,
        'created_at', r.created_at
      )
    ),
    '[]'::jsonb
  )
  INTO v_history
  FROM (
    SELECT result, choice, is_win, bet_amount, payout_amount, created_at
    FROM public."GameRound"
    WHERE game_key = 'redblack'
      AND user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 10
  ) r;

  RETURN jsonb_build_object(
    'game_key', 'redblack',
    'balance', COALESCE(v_balance, 0),
    'is_active', v_setting.is_active,
    'win_chance', v_setting.win_chance,
    'multiplier', v_setting.multiplier,
    'green_multiplier', 14,
    'min_bet', v_setting.min_bet,
    'max_bet', v_setting.max_bet,
    'history', v_history
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.redblack_play(
  p_user_id uuid,
  p_telegram_id bigint,
  p_choice text,
  p_bet_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_setting public."GameSetting"%ROWTYPE;
  v_choice text;
  v_result text;
  v_bet numeric;
  v_min_bet numeric;
  v_max_bet numeric;
  v_balance_before numeric := 0;
  v_balance_after numeric := 0;
  v_base_chance numeric := 0;
  v_effective_chance numeric := 0;
  v_multiplier numeric := 2;
  v_payout numeric := 0;
  v_profit numeric := 0;
  v_is_win boolean := false;
  v_round_id uuid;
  v_state jsonb;
BEGIN
  v_choice := lower(trim(COALESCE(p_choice, '')));

  IF v_choice IN ('красное', 'красный', 'red') THEN
    v_choice := 'red';
  ELSIF v_choice IN ('чёрное', 'черное', 'чёрный', 'черный', 'black') THEN
    v_choice := 'black';
  ELSIF v_choice IN ('зелёное', 'зеленое', 'зелёный', 'зеленый', 'green') THEN
    v_choice := 'green';
  ELSE
    RAISE EXCEPTION 'Некорректный выбор';
  END IF;

  v_bet := floor(COALESCE(p_bet_amount, 0));

  IF v_bet <= 0 THEN
    RAISE EXCEPTION 'Некорректная ставка';
  END IF;

  SELECT *
  INTO v_setting
  FROM public."GameSetting"
  WHERE game_key = 'redblack'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Настройки redblack не найдены';
  END IF;

  IF NOT v_setting.is_active THEN
    RAISE EXCEPTION 'Игра временно недоступна';
  END IF;

  v_min_bet := floor(COALESCE(v_setting.min_bet, 8));
  v_max_bet := floor(COALESCE(v_setting.max_bet, 10000));

  IF v_bet < v_min_bet THEN
    RAISE EXCEPTION 'Минимальная ставка % ₽', v_min_bet;
  END IF;

  IF v_bet > v_max_bet THEN
    RAISE EXCEPTION 'Максимальная ставка % ₽', v_max_bet;
  END IF;

  SELECT b.balance
  INTO v_balance_before
  FROM public."Balance" b
  WHERE b.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public."Balance" (user_id, telegram_id, balance, currency)
    VALUES (p_user_id, p_telegram_id, 0, 'RUB');
    v_balance_before := 0;
  END IF;

  v_balance_before := COALESCE(v_balance_before, 0);

  IF v_bet > v_balance_before THEN
    RAISE EXCEPTION 'Недостаточно средств';
  END IF;

  v_base_chance := LEAST(100, GREATEST(0, COALESCE(v_setting.win_chance, 0)));

  IF v_choice = 'green' THEN
    v_effective_chance := LEAST(8, v_base_chance / 7.0);
    v_multiplier := 14;
  ELSE
    v_effective_chance := v_base_chance;
    v_multiplier := COALESCE(NULLIF(v_setting.multiplier, 0), 2);
  END IF;

  v_is_win := (random() * 100) < v_effective_chance;

  IF v_is_win THEN
    v_result := v_choice;
  ELSE
    IF v_choice = 'green' THEN
      v_result := CASE WHEN random() < 0.5 THEN 'red' ELSE 'black' END;
    ELSIF v_choice = 'red' THEN
      v_result := CASE WHEN random() < 0.93 THEN 'black' ELSE 'green' END;
    ELSE
      v_result := CASE WHEN random() < 0.93 THEN 'red' ELSE 'green' END;
    END IF;
  END IF;

  v_payout := CASE WHEN v_is_win THEN v_bet * v_multiplier ELSE 0 END;
  v_profit := v_payout - v_bet;
  v_balance_after := v_balance_before - v_bet + v_payout;

  UPDATE public."Balance"
  SET
    balance = v_balance_after,
    telegram_id = p_telegram_id,
    currency = COALESCE(currency, 'RUB'),
    updated_at = now()
  WHERE user_id = p_user_id;

  v_state := jsonb_build_object(
    'choice', v_choice,
    'result', v_result,
    'base_win_chance', v_base_chance,
    'effective_win_chance', v_effective_chance,
    'ordinary_multiplier', COALESCE(v_setting.multiplier, 2),
    'green_multiplier', 14
  );

  INSERT INTO public."GameRound" (
    game_key,
    user_id,
    telegram_id,
    choice,
    result,
    is_win,
    bet_amount,
    payout_amount,
    profit_amount,
    multiplier,
    win_chance,
    balance_before,
    balance_after,
    status,
    state,
    ended_at
  ) VALUES (
    'redblack',
    p_user_id,
    p_telegram_id,
    v_choice,
    v_result,
    v_is_win,
    v_bet,
    v_payout,
    v_profit,
    v_multiplier,
    v_base_chance,
    v_balance_before,
    v_balance_after,
    'finished',
    v_state,
    now()
  )
  RETURNING id INTO v_round_id;

  RETURN jsonb_build_object(
    'round_id', v_round_id,
    'game_key', 'redblack',
    'balance', v_balance_after,
    'balance_before', v_balance_before,
    'balance_after', v_balance_after,
    'choice', v_choice,
    'result', v_result,
    'is_win', v_is_win,
    'bet_amount', v_bet,
    'payout_amount', v_payout,
    'profit_amount', v_profit,
    'multiplier', v_multiplier,
    'win_chance', v_base_chance,
    'effective_win_chance', v_effective_chance,
    'min_bet', v_min_bet,
    'max_bet', v_max_bet,
    'is_active', v_setting.is_active
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.redblack_get_state(uuid, bigint) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redblack_play(uuid, bigint, text, numeric) TO anon, authenticated, service_role;
