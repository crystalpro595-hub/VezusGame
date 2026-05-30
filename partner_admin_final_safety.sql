-- Финальная страховка для партнёрской системы админки.
-- Можно выполнить повторно: команды idempotent.

create extension if not exists pgcrypto;

alter table public."PartnerEarning"
add column if not exists updated_at timestamptz default now();

create or replace function public.set_partner_earning_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_partner_earning_updated_at on public."PartnerEarning";

create trigger trg_partner_earning_updated_at
before update on public."PartnerEarning"
for each row
execute function public.set_partner_earning_updated_at();

create table if not exists public."PartnerPayoutRequest" (
  id uuid primary key default gen_random_uuid(),
  partner_user_id uuid not null references public."User"(id) on delete cascade,
  amount numeric not null check (amount > 0),
  method text not null default 'manual',
  requisites text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'paid', 'rejected')),
  admin_comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  paid_at timestamptz,
  rejected_at timestamptz
);

create index if not exists idx_partner_payout_request_partner
  on public."PartnerPayoutRequest"(partner_user_id, created_at desc);

create index if not exists idx_partner_payout_request_status
  on public."PartnerPayoutRequest"(status, created_at desc);

notify pgrst, 'reload schema';
