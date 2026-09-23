-- Phase 2B5.5I: durable accounting for an explicitly requested Fed diff AI call.
-- Existing rows remain valid; only future interpretations have a receipt.
alter table public.mic_fed_statement_diffs
  add column if not exists ai_usage_receipt jsonb,
  add column if not exists ai_usage_recorded_at timestamptz;

alter table public.ai_usage_events
  add column if not exists usage_event_key text;

create unique index if not exists ai_usage_events_usage_event_key_uidx
  on public.ai_usage_events (usage_event_key)
  where usage_event_key is not null;

-- Called only after the interpretation and receipt have been saved together.
-- One RPC invocation is one short database transaction; no external AI call
-- is made while holding the diff row lock.
create or replace function public.record_mic_fed_statement_diff_usage(p_diff_id uuid)
returns table(usage_event_id bigint, result_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_diff public.mic_fed_statement_diffs%rowtype;
  v_receipt jsonb;
  v_key text;
  v_input_tokens integer;
  v_output_tokens integer;
  v_web_search_calls integer;
  v_cost_usd numeric(12, 8);
  v_usage public.ai_usage_events%rowtype;
  v_inserted boolean := false;
begin
  select * into v_diff
  from public.mic_fed_statement_diffs
  where id = p_diff_id
  for update;

  if not found then
    raise exception 'FED_AI_DIFF_NOT_FOUND';
  end if;

  v_receipt := v_diff.ai_usage_receipt;
  if v_diff.ai_interpretation is null or v_diff.generated_at is null or
     v_diff.model is distinct from 'gpt-6-luna' or v_receipt is null then
    raise exception 'FED_AI_USAGE_RECEIPT_INCOMPLETE';
  end if;
  if jsonb_typeof(v_receipt) is distinct from 'object' or
     jsonb_typeof(v_receipt->'input_tokens') is distinct from 'number' or
     jsonb_typeof(v_receipt->'output_tokens') is distinct from 'number' or
     jsonb_typeof(v_receipt->'web_search_calls') is distinct from 'number' or
     jsonb_typeof(v_receipt->'cost_usd') is distinct from 'number' then
    raise exception 'FED_AI_USAGE_RECEIPT_INVALID';
  end if;

  v_key := 'mic_fed_statement_diff:' || p_diff_id::text || ':' ||
    v_diff.prompt_version || ':' || v_diff.diff_hash || ':' || v_diff.model;
  if v_receipt->>'feature' is distinct from 'mic_fed_statement_diff' or
     v_receipt->>'diff_id' is distinct from p_diff_id::text or
     v_receipt->>'diff_hash' is distinct from v_diff.diff_hash or
     v_receipt->>'prompt_version' is distinct from v_diff.prompt_version or
     v_receipt->>'model' is distinct from v_diff.model or
     v_receipt->>'usage_event_key' is distinct from v_key or
     (v_receipt->>'generated_at')::timestamptz is distinct from v_diff.generated_at then
    raise exception 'FED_AI_USAGE_RECEIPT_IDENTITY_MISMATCH';
  end if;

  v_input_tokens := (v_receipt->>'input_tokens')::integer;
  v_output_tokens := (v_receipt->>'output_tokens')::integer;
  v_web_search_calls := (v_receipt->>'web_search_calls')::integer;
  v_cost_usd := (v_receipt->>'cost_usd')::numeric(12, 8);
  if v_input_tokens < 0 or v_output_tokens < 0 or v_web_search_calls <> 0 or v_cost_usd < 0 then
    raise exception 'FED_AI_USAGE_RECEIPT_VALUES_INVALID';
  end if;

  -- A pre-migration ledger row cannot be attributed to a particular prompt
  -- or diff hash. Require explicit review instead of silently double counting.
  if exists (
    select 1 from public.ai_usage_events
    where feature = 'mic_fed_statement_diff'
      and related_table = 'mic_fed_statement_diffs'
      and related_id = p_diff_id::text
      and usage_event_key is null
  ) then
    raise exception 'FED_AI_LEGACY_USAGE_ROW_REQUIRES_REVIEW';
  end if;

  select * into v_usage
  from public.ai_usage_events
  where usage_event_key = v_key;

  if not found then
    if v_diff.ai_usage_recorded_at is not null then
      raise exception 'FED_AI_USAGE_LEDGER_MISSING';
    end if;
    insert into public.ai_usage_events (
      feature, model, input_tokens, output_tokens, web_search_calls,
      cost_usd, related_table, related_id, usage_event_key
    ) values (
      'mic_fed_statement_diff', v_diff.model, v_input_tokens,
      v_output_tokens, v_web_search_calls, v_cost_usd,
      'mic_fed_statement_diffs', p_diff_id::text, v_key
    )
    on conflict (usage_event_key) where usage_event_key is not null do nothing
    returning * into v_usage;
    v_inserted := found;

    if not found then
      select * into v_usage
      from public.ai_usage_events
      where usage_event_key = v_key;
    end if;
  end if;

  if v_usage.id is null or
     v_usage.feature is distinct from 'mic_fed_statement_diff' or
     v_usage.model is distinct from v_diff.model or
     v_usage.related_table is distinct from 'mic_fed_statement_diffs' or
     v_usage.related_id is distinct from p_diff_id::text or
     v_usage.input_tokens is distinct from v_input_tokens or
     v_usage.output_tokens is distinct from v_output_tokens or
     v_usage.web_search_calls is distinct from v_web_search_calls or
     v_usage.cost_usd is distinct from v_cost_usd then
    raise exception 'FED_AI_USAGE_LEDGER_CONFLICT';
  end if;

  if v_diff.ai_usage_recorded_at is null then
    update public.mic_fed_statement_diffs
    set ai_usage_recorded_at = now()
    where id = p_diff_id;
  end if;

  usage_event_id := v_usage.id;
  result_status := case when v_inserted then 'recorded' else 'already_recorded' end;
  return next;
end;
$$;

revoke all on function public.record_mic_fed_statement_diff_usage(uuid)
  from public, anon, authenticated;
grant execute on function public.record_mic_fed_statement_diff_usage(uuid)
  to service_role;
