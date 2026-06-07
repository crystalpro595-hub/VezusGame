-- Vezus Cups FIX v4: исправление обязательной колонки GameRound.choice
-- Используем ТОЛЬКО существующие таблицы: "GameSetting", "GameRound", "User", "Balance".
-- Новые таблицы не создаются.
-- Исправление: всегда передаём choice в GameRound, потому что в твоей таблице эта колонка NOT NULL.

insert into public."GameSetting" (
  game_key,
  title,
  is_active,
  win_chance,
  multiplier,
  min_bet,
  max_bet,
  created_at,
  updated_at
)
select
  'cups',
  'Cups',
  true,
  45,
  2,
  8,
  10000,
  now(),
  now()
where not exists (
  select 1 from public."GameSetting" where game_key = 'cups'
);

create or replace function public.cups_try_insert_game_round_existing(
  p_payload jsonb,
  p_candidate_columns text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_col text;
  v_cols text[] := array[]::text[];
  v_vals text[] := array[]::text[];
  v_round_id uuid;
begin
  foreach v_col in array p_candidate_columns loop
    if (p_payload ? v_col) and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'GameRound'
        and column_name = v_col
    ) then
      v_cols := array_append(v_cols, format('%I', v_col));
      v_vals := array_append(v_vals, quote_nullable(p_payload ->> v_col));
    end if;
  end loop;

  if array_length(v_cols, 1) is null then
    raise exception 'В GameRound не найдено подходящих колонок для записи раунда';
  end if;

  execute format(
    'insert into public."GameRound" (%s) values (%s) returning id',
    array_to_string(v_cols, ', '),
    array_to_string(v_vals, ', ')
  ) into v_round_id;

  return v_round_id;
end;
$$;

create or replace function public.cups_insert_game_round_existing(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_full_columns text[] := array[
    'user_id',
    'player_id',
    'telegram_id',
    'game_key',
    'game',
    'game_type',
    'game_name',
    'title',
    'bet_amount',
    'bet',
    'stake_amount',
    'stake',
    'amount',
    'multiplier',
    'coefficient',
    'coef',
    'win_chance',
    'chance',
    'choice',
    'selected_cup',
    'user_choice',
    'final_ball_cup',
    'result_cup',
    'winning_cup',
    'is_win',
    'payout_amount',
    'payout',
    'win_amount',
    'reward',
    'prize',
    'profit_amount',
    'profit',
    'net_profit',
    'balance_change',
    'status',
    'state',
    'result',
    'outcome',
    'balance_before',
    'balance_after',
    'currency',
    'created_at',
    'updated_at',
    'finished_at'
  ];
  v_safe_columns text[] := array[
    'user_id',
    'telegram_id',
    'game_key',
    'game',
    'bet_amount',
    'bet',
    'amount',
    'multiplier',
    'coefficient',
    'win_chance',
    'choice',
    'selected_cup',
    'final_ball_cup',
    'is_win',
    'payout_amount',
    'payout',
    'win_amount',
    'profit_amount',
    'profit',
    'result',
    'status',
    'balance_before',
    'balance_after',
    'created_at',
    'updated_at'
  ];
  v_min_columns text[] := array[
    'user_id',
    'telegram_id',
    'game_key',
    'game',
    'bet_amount',
    'bet',
    'amount',
    'choice',
    'is_win',
    'win_amount',
    'payout_amount',
    'result',
    'status',
    'created_at'
  ];
begin
  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'GameRound'
  ) then
    raise exception 'Таблица GameRound не найдена';
  end if;

  begin
    return public.cups_try_insert_game_round_existing(p_payload, v_full_columns);
  exception when others then
    begin
      return public.cups_try_insert_game_round_existing(p_payload, v_safe_columns);
    exception when others then
      return public.cups_try_insert_game_round_existing(p_payload, v_min_columns);
    end;
  end;
end;
$$;

create or replace function public.cups_get_state(
  p_user_id uuid,
  p_telegram_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric(14,2) := 0;
  v_title text;
  v_is_active boolean;
  v_win_chance numeric(6,2);
  v_multiplier numeric(10,2);
  v_min_bet integer;
  v_max_bet integer;
begin
  if p_user_id is null then
    raise exception 'Пользователь не найден';
  end if;

  select balance
    into v_balance
  from public."Balance"
  where user_id = p_user_id
  limit 1;

  v_balance := coalesce(v_balance, 0);

  select
    title,
    is_active,
    win_chance,
    multiplier,
    min_bet,
    max_bet
    into
    v_title,
    v_is_active,
    v_win_chance,
    v_multiplier,
    v_min_bet,
    v_max_bet
  from public."GameSetting"
  where game_key = 'cups'
  limit 1;

  if not found then
    insert into public."GameSetting" (
      game_key,
      title,
      is_active,
      win_chance,
      multiplier,
      min_bet,
      max_bet,
      created_at,
      updated_at
    ) values (
      'cups',
      'Cups',
      true,
      45,
      2,
      8,
      10000,
      now(),
      now()
    );

    select
      title,
      is_active,
      win_chance,
      multiplier,
      min_bet,
      max_bet
      into
      v_title,
      v_is_active,
      v_win_chance,
      v_multiplier,
      v_min_bet,
      v_max_bet
    from public."GameSetting"
    where game_key = 'cups'
    limit 1;
  end if;

  return jsonb_build_object(
    'balance', v_balance,
    'game_key', 'cups',
    'title', coalesce(v_title, 'Cups'),
    'is_active', coalesce(v_is_active, true),
    'win_chance', greatest(0, least(100, coalesce(v_win_chance, 45))),
    'multiplier', coalesce(v_multiplier, 2),
    'min_bet', coalesce(v_min_bet, 8),
    'max_bet', coalesce(v_max_bet, 10000)
  );
end;
$$;

create or replace function public.cups_play(
  p_user_id uuid,
  p_telegram_id bigint,
  p_selected_cup integer,
  p_bet_amount integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric(14,2);
  v_new_balance numeric(14,2);
  v_title text;
  v_is_active boolean;
  v_win_chance numeric(6,2);
  v_multiplier numeric(10,2);
  v_min_bet integer;
  v_max_bet integer;
  v_is_win boolean;
  v_final_ball_cup integer;
  v_payout integer;
  v_profit integer;
  v_round_id uuid;
  v_payload jsonb;
begin
  if p_user_id is null then
    raise exception 'Пользователь не найден';
  end if;

  if p_selected_cup is null or p_selected_cup < 0 or p_selected_cup > 2 then
    raise exception 'Некорректный стаканчик';
  end if;

  if p_bet_amount is null or p_bet_amount < 1 then
    raise exception 'Некорректная ставка';
  end if;

  select
    title,
    is_active,
    win_chance,
    multiplier,
    min_bet,
    max_bet
    into
    v_title,
    v_is_active,
    v_win_chance,
    v_multiplier,
    v_min_bet,
    v_max_bet
  from public."GameSetting"
  where game_key = 'cups'
  limit 1;

  if not found then
    insert into public."GameSetting" (
      game_key,
      title,
      is_active,
      win_chance,
      multiplier,
      min_bet,
      max_bet,
      created_at,
      updated_at
    ) values (
      'cups',
      'Cups',
      true,
      45,
      2,
      8,
      10000,
      now(),
      now()
    );

    select
      title,
      is_active,
      win_chance,
      multiplier,
      min_bet,
      max_bet
      into
      v_title,
      v_is_active,
      v_win_chance,
      v_multiplier,
      v_min_bet,
      v_max_bet
    from public."GameSetting"
    where game_key = 'cups'
    limit 1;
  end if;

  if coalesce(v_is_active, true) is not true then
    raise exception 'Игра временно недоступна';
  end if;

  v_win_chance := greatest(0, least(100, coalesce(v_win_chance, 45)));
  v_multiplier := coalesce(v_multiplier, 2);
  v_min_bet := coalesce(v_min_bet, 8);
  v_max_bet := coalesce(v_max_bet, 10000);

  if p_bet_amount < v_min_bet then
    raise exception 'Минимальная ставка % ₽', v_min_bet;
  end if;

  if p_bet_amount > v_max_bet then
    raise exception 'Максимальная ставка % ₽', v_max_bet;
  end if;

  select balance
    into v_balance
  from public."Balance"
  where user_id = p_user_id
  for update;

  if not found then
    -- Обычно баланс уже создаётся регистрацией/кошельком.
    -- Оставляем мягкий fallback, чтобы игра не падала на новом пользователе.
    insert into public."Balance" (user_id, telegram_id, balance, currency, updated_at)
    values (p_user_id, p_telegram_id, 0, 'RUB', now())
    returning balance into v_balance;
  end if;

  v_balance := coalesce(v_balance, 0);

  if v_balance < p_bet_amount then
    raise exception 'Недостаточно средств';
  end if;

  v_is_win := (random() * 100) < v_win_chance;

  if v_is_win then
    v_final_ball_cup := p_selected_cup;
    v_payout := floor(p_bet_amount * v_multiplier)::integer;
    v_profit := v_payout - p_bet_amount;
  else
    v_final_ball_cup := (p_selected_cup + 1 + floor(random() * 2)::integer) % 3;
    v_payout := 0;
    v_profit := -p_bet_amount;
  end if;

  v_new_balance := v_balance - p_bet_amount + v_payout;

  update public."Balance"
     set balance = v_new_balance,
         updated_at = now()
   where user_id = p_user_id;

  v_payload := jsonb_build_object(
    'user_id', p_user_id,
    'player_id', p_user_id,
    'telegram_id', p_telegram_id,
    'game_key', 'cups',
    'game', 'cups',
    'game_type', 'cups',
    'game_name', 'Cups',
    'title', 'Cups',
    'bet_amount', p_bet_amount,
    'bet', p_bet_amount,
    'stake_amount', p_bet_amount,
    'stake', p_bet_amount,
    'amount', p_bet_amount,
    'multiplier', v_multiplier,
    'coefficient', v_multiplier,
    'coef', v_multiplier,
    'win_chance', v_win_chance,
    'chance', v_win_chance,
    'choice', p_selected_cup,
    'selected_cup', p_selected_cup,
    'user_choice', p_selected_cup,
    'final_ball_cup', v_final_ball_cup,
    'result_cup', v_final_ball_cup,
    'winning_cup', v_final_ball_cup,
    'is_win', v_is_win,
    'payout_amount', v_payout,
    'payout', v_payout,
    'win_amount', v_payout,
    'reward', v_payout,
    'prize', v_payout,
    'profit_amount', v_profit,
    'profit', v_profit,
    'net_profit', v_profit,
    'balance_change', v_profit,
    'status', 'finished',
    'state', 'finished',
    'result', case when v_is_win then 'win' else 'lose' end,
    'outcome', case when v_is_win then 'win' else 'lose' end,
    'balance_before', v_balance,
    'balance_after', v_new_balance,
    'currency', 'RUB',
    'created_at', now(),
    'updated_at', now(),
    'finished_at', now()
  );

  v_round_id := public.cups_insert_game_round_existing(v_payload);

  return jsonb_build_object(
    'round_id', v_round_id,
    'balance', v_new_balance,
    'bet_amount', p_bet_amount,
    'selected_cup', p_selected_cup,
    'final_ball_cup', v_final_ball_cup,
    'is_win', v_is_win,
    'payout_amount', v_payout,
    'profit_amount', v_profit,
    'multiplier', v_multiplier,
    'win_chance', v_win_chance,
    'min_bet', v_min_bet,
    'max_bet', v_max_bet
  );
end;
$$;
