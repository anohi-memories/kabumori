create table if not exists public.useful_tips (
  id uuid primary key default gen_random_uuid(),
  title text not null unique,
  category text not null,
  topic_description text not null,
  source_hint text,
  fact_check_required boolean not null default true,
  last_used_at timestamptz,
  use_count integer not null default 0 check (use_count >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.useful_tip_verifications (
  id uuid primary key default gen_random_uuid(),
  useful_tip_id uuid not null references public.useful_tips(id),
  source_urls jsonb not null default '[]'::jsonb,
  verified_at timestamptz not null default now(),
  model text not null,
  escalated_to_sol boolean not null default false,
  input_tokens integer,
  output_tokens integer,
  api_cost_usd numeric(12,6),
  fact_check_status text not null check (fact_check_status in ('passed','failed','skipped')),
  generated_text text,
  error_code text,
  created_at timestamptz not null default now()
);
create table if not exists public.useful_tip_schedule_settings (
  id boolean primary key default true check (id),
  is_active boolean not null default false,
  posts_per_week smallint not null default 4 check (posts_per_week between 0 and 7),
  cooldown_days integer not null default 150 check (cooldown_days >= 1),
  window_a_start time not null default '11:50',
  window_a_end time not null default '12:10',
  window_b_start time not null default '19:10',
  window_b_end time not null default '19:40',
  collision_minutes integer not null default 20,
  timezone text not null default 'Asia/Tokyo',
  updated_at timestamptz not null default now()
);
insert into public.useful_tip_schedule_settings(id,is_active) values(true,false) on conflict(id) do nothing;
alter table public.useful_tips enable row level security;
alter table public.useful_tip_verifications enable row level security;
alter table public.useful_tip_schedule_settings enable row level security;
grant select on public.useful_tips,public.useful_tip_verifications,public.useful_tip_schedule_settings to service_role;
grant insert,update on public.useful_tip_verifications to service_role;
alter table public.post_execution_logs add column if not exists useful_tip_id uuid references public.useful_tips(id);
alter table public.post_execution_logs add column if not exists source_urls jsonb;
alter table public.post_execution_logs add column if not exists verified_at timestamptz;
alter table public.post_execution_logs add column if not exists model_used text;
alter table public.post_execution_logs add column if not exists escalated_to_sol boolean;
alter table public.post_execution_logs add column if not exists input_tokens integer;
alter table public.post_execution_logs add column if not exists output_tokens integer;
alter table public.post_execution_logs add column if not exists api_cost_usd numeric(12,6);
alter table public.post_execution_logs add column if not exists error_code text;
insert into public.useful_tips(title,category,topic_description,source_hint,fact_check_required) values
  ('特定口座「源泉徴収あり」と「なし」で税金を払うタイミングが違う','税金・口座','特定口座「源泉徴収あり」と「なし」で税金を払うタイミングが違う','https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1476.htm',true),
  ('源泉徴収なしでは利益を再投資できる期間が生まれることがある','税金・口座','源泉徴収なしでは利益を再投資できる期間が生まれることがある',null,true),
  ('株の利益と損失を損益通算できる仕組み','税金・口座','株の利益と損失を損益通算できる仕組み',null,true),
  ('株の損失を翌年以降へ繰り越せる制度','税金・口座','株の損失を翌年以降へ繰り越せる制度',null,true),
  ('年末の「損出し」は何をしているのか','税金・口座','年末の「損出し」は何をしているのか',null,true),
  ('複数証券会社の利益と損失を通算する方法','税金・口座','複数証券会社の利益と損失を通算する方法',null,true),
  ('特定口座年間取引報告書は何に使うのか','税金・口座','特定口座年間取引報告書は何に使うのか',null,true),
  ('一般口座を使うと何が面倒になるのか','税金・口座','一般口座を使うと何が面倒になるのか',null,true),
  ('配当と売買損益を通算できるケース','税金・口座','配当と売買損益を通算できるケース',null,true),
  ('確定申告すると税金以外に影響するケースがある理由','税金・口座','確定申告すると税金以外に影響するケースがある理由',null,true),
  ('NISAの損失は特定口座の利益と相殺できない','NISA','NISAの損失は特定口座の利益と相殺できない',null,true),
  ('NISAで配当を非課税にするための受取方法','NISA','NISAで配当を非課税にするための受取方法','https://www.fsa.go.jp/policy/nisa2/about/nisa2024/slide_202406.pdf',true),
  ('NISA株を売った投資枠はいつ復活するのか','NISA','NISA株を売った投資枠はいつ復活するのか',null,true),
  ('NISAで損切りしても税金上の損失にならない','NISA','NISAで損切りしても税金上の損失にならない',null,true),
  ('NISAと特定口座で同じ銘柄を持つ場合の考え方','NISA','NISAと特定口座で同じ銘柄を持つ場合の考え方',null,true),
  ('NISAで外国株を持っても外国税がかかる場合がある','NISA','NISAで外国株を持っても外国税がかかる場合がある',null,true),
  ('NISA口座の金融機関変更でできること・できないこと','NISA','NISA口座の金融機関変更でできること・できないこと',null,true),
  ('NISAの年間投資枠と生涯投資枠の違い','NISA','NISAの年間投資枠と生涯投資枠の違い',null,true),
  ('NISAで保有株を売却した場合の枠の扱い','NISA','NISAで保有株を売却した場合の枠の扱い',null,true),
  ('特定口座で持っている株をそのままNISAへ移せない理由','NISA','特定口座で持っている株をそのままNISAへ移せない理由',null,true),
  ('権利付き最終日と権利確定日の違い','配当・権利','権利付き最終日と権利確定日の違い',null,true),
  ('権利落ち日に株価が下がりやすい理由','配当・権利','権利落ち日に株価が下がりやすい理由',null,true),
  ('配当金を受け取れる人が決まる仕組み','配当・権利','配当金を受け取れる人が決まる仕組み',null,true),
  ('中間配当と期末配当の違い','配当・権利','中間配当と期末配当の違い',null,true),
  ('記念配当を通常配当と勘違いすると利回り表示がズレる','配当・権利','記念配当を通常配当と勘違いすると利回り表示がズレる',null,true),
  ('特別配当が翌年も続くとは限らない','配当・権利','特別配当が翌年も続くとは限らない',null,true),
  ('配当利回り表示は将来の配当を保証していない','配当・権利','配当利回り表示は将来の配当を保証していない',null,true),
  ('信用買いでは「配当金」ではなく配当落調整金になる','配当・権利','信用買いでは「配当金」ではなく配当落調整金になる',null,true),
  ('信用売りで権利日をまたぐと配当相当額を支払うことがある','配当・権利','信用売りで権利日をまたぐと配当相当額を支払うことがある',null,true),
  ('配当金の受取方法には複数種類ある','配当・権利','配当金の受取方法には複数種類ある',null,true),
  ('貸株中の株主優待はどうなるのか','株主優待・貸株','貸株中の株主優待はどうなるのか','https://www.rakuten-sec.co.jp/web/domestic/lending/rule/auto_service.html;https://faq.sbisec.co.jp/answer/641d1e5c00994e3de05de02c/',true),
  ('貸株サービスの「自動返却」とは何か','株主優待・貸株','貸株サービスの「自動返却」とは何か',null,true),
  ('貸株すると株主番号に影響する場合がある','株主優待・貸株','貸株すると株主番号に影響する場合がある',null,true),
  ('長期保有優待で重要になる「同一株主番号」','株主優待・貸株','長期保有優待で重要になる「同一株主番号」',null,true),
  ('株主優待クロスは完全無料ではない','株主優待・貸株','株主優待クロスは完全無料ではない',null,true),
  ('優待クロスで逆日歩が発生するケース','株主優待・貸株','優待クロスで逆日歩が発生するケース',null,true),
  ('一般信用と制度信用で優待クロスのリスクが違う','株主優待・貸株','一般信用と制度信用で優待クロスのリスクが違う',null,true),
  ('100株未満でも対象になる優待が存在する','株主優待・貸株','100株未満でも対象になる優待が存在する',null,true),
  ('株主優待の長期保有条件は会社ごとに違う','株主優待・貸株','株主優待の長期保有条件は会社ごとに違う',null,true),
  ('優待価値を額面そのままで考えない方がいい理由','株主優待・貸株','優待価値を額面そのままで考えない方がいい理由',null,true),
  ('指値価格まで株価が来ても約定しないことがある','注文・約定','指値価格まで株価が来ても約定しないことがある',null,true),
  ('成行注文は想像以上に高値・安値で約定することがある','注文・約定','成行注文は想像以上に高値・安値で約定することがある',null,true),
  ('逆指値の発動価格と実際の約定価格は違う','注文・約定','逆指値の発動価格と実際の約定価格は違う',null,true),
  ('逆指値＋指値では約定しないケースがある','注文・約定','逆指値＋指値では約定しないケースがある',null,true),
  ('寄付きの成行注文で価格が大きく飛ぶことがある','注文・約定','寄付きの成行注文で価格が大きく飛ぶことがある',null,true),
  ('同じ価格の指値でも注文順で約定優先度が変わる','注文・約定','同じ価格の指値でも注文順で約定優先度が変わる',null,true),
  ('一部だけ約定する「部分約定」','注文・約定','一部だけ約定する「部分約定」',null,true),
  ('単元未満株は通常の100株注文と約定方式が違う場合がある','注文・約定','単元未満株は通常の100株注文と約定方式が違う場合がある',null,true),
  ('注文の有効期限が切れると自動的に失効する','注文・約定','注文の有効期限が切れると自動的に失効する',null,true),
  ('板に見えている注文数量がずっと存在するとは限らない','注文・約定','板に見えている注文数量がずっと存在するとは限らない',null,true),
  ('信用買いは土日にも金利がかかる場合がある','信用取引','信用買いは土日にも金利がかかる場合がある',null,true),
  ('信用売りでは貸株料が発生する','信用取引','信用売りでは貸株料が発生する',null,true),
  ('逆日歩は普通の貸株料とは別物','信用取引','逆日歩は普通の貸株料とは別物',null,true),
  ('保証金維持率が下がると何が起きるのか','信用取引','保証金維持率が下がると何が起きるのか',null,true),
  ('含み損が信用余力にも影響する','信用取引','含み損が信用余力にも影響する',null,true),
  ('制度信用と一般信用では返済期限が違う','信用取引','制度信用と一般信用では返済期限が違う',null,true),
  ('信用取引で権利日をまたぐ時の注意','信用取引','信用取引で権利日をまたぐ時の注意',null,true),
  ('信用売りできる銘柄はいつでも同じではない','信用取引','信用売りできる銘柄はいつでも同じではない',null,true),
  ('信用在庫がなくなると新規売建できない場合がある','信用取引','信用在庫がなくなると新規売建できない場合がある',null,true),
  ('現物と信用を同時に持つ時の資金管理','信用取引','現物と信用を同時に持つ時の資金管理',null,true),
  ('ETFの市場価格と基準価額は完全には同じではない','ETF・投資信託','ETFの市場価格と基準価額は完全には同じではない',null,true),
  ('ETFは銘柄によって売買の厚みがかなり違う','ETF・投資信託','ETFは銘柄によって売買の厚みがかなり違う',null,true),
  ('投資信託は注文時点で購入価格が分からない','ETF・投資信託','投資信託は注文時点で購入価格が分からない',null,true),
  ('投資信託には注文締切時間がある','ETF・投資信託','投資信託には注文締切時間がある',null,true),
  ('海外資産投信では日本市場休場日以外も基準価額に影響する','ETF・投資信託','海外資産投信では日本市場休場日以外も基準価額に影響する',null,true),
  ('投資信託の「普通分配金」と「特別分配金」の違い','ETF・投資信託','投資信託の「普通分配金」と「特別分配金」の違い',null,true),
  ('特別分配金は利益ではなく元本の払い戻しになる場合がある','ETF・投資信託','特別分配金は利益ではなく元本の払い戻しになる場合がある',null,true),
  ('為替ヘッジあり投信にはヘッジコストが存在する','ETF・投資信託','為替ヘッジあり投信にはヘッジコストが存在する',null,true),
  ('投資信託によって売却代金が入る日数が違う','ETF・投資信託','投資信託によって売却代金が入る日数が違う',null,true),
  ('信託財産留保額が設定されている投信がある','ETF・投資信託','信託財産留保額が設定されている投信がある',null,true),
  ('NISAの米国株配当でも米国側の税金が引かれる場合がある','米国株・為替','NISAの米国株配当でも米国側の税金が引かれる場合がある',null,true),
  ('米国株のADRにはADR手数料がかかる銘柄がある','米国株・為替','米国株のADRにはADR手数料がかかる銘柄がある',null,true),
  ('円貨決済と外貨決済では為替コストが違う','米国株・為替','円貨決済と外貨決済では為替コストが違う',null,true),
  ('ドル転するタイミングで実質的な購入価格が変わる','米国株・為替','ドル転するタイミングで実質的な購入価格が変わる',null,true),
  ('米国市場は夏時間と冬時間で日本時間の開始時刻が変わる','米国株・為替','米国市場は夏時間と冬時間で日本時間の開始時刻が変わる',null,true),
  ('プレマーケットは通常時間より流動性が低い','米国株・為替','プレマーケットは通常時間より流動性が低い',null,true),
  ('アフターマーケットでは値段が飛びやすい','米国株・為替','アフターマーケットでは値段が飛びやすい',null,true),
  ('米国株の端株では議決権などの扱いが違う場合がある','米国株・為替','米国株の端株では議決権などの扱いが違う場合がある',null,true),
  ('W-8BENは何のためにあるのか','米国株・為替','W-8BENは何のためにあるのか',null,true),
  ('米国株の外国税額控除が使えるケース','米国株・為替','米国株の外国税額控除が使えるケース',null,true),
  ('株を売っても売却代金が正式に受け渡されるのは後日','証券会社・資金管理','株を売っても売却代金が正式に受け渡されるのは後日',null,true),
  ('「買付余力」と銀行口座残高は同じではない','証券会社・資金管理','「買付余力」と銀行口座残高は同じではない',null,true),
  ('証券会社の自動入出金・スイープ機能とは何か','証券会社・資金管理','証券会社の自動入出金・スイープ機能とは何か',null,true),
  ('保有株を売らずに別の証券会社へ移管できる','証券会社・資金管理','保有株を売らずに別の証券会社へ移管できる',null,true),
  ('株式移管には日数や手数料がかかる場合がある','証券会社・資金管理','株式移管には日数や手数料がかかる場合がある',null,true),
  ('手数料プランは取引回数によって有利不利が変わる','証券会社・資金管理','手数料プランは取引回数によって有利不利が変わる',null,true),
  ('PTSを使える証券会社と使えない証券会社がある','証券会社・資金管理','PTSを使える証券会社と使えない証券会社がある',null,true),
  ('同じPTSでも証券会社によって利用時間が違う場合がある','証券会社・資金管理','同じPTSでも証券会社によって利用時間が違う場合がある',null,true),
  ('年間取引報告書は電子交付で保存されていることが多い','証券会社・資金管理','年間取引報告書は電子交付で保存されていることが多い',null,true),
  ('税金・手数料分の現金余力を残しておく意味','証券会社・資金管理','税金・手数料分の現金余力を残しておく意味',null,true),
  ('株式分割をすると保有株数と株価はどう変わるのか','企業イベント・実務','株式分割をすると保有株数と株価はどう変わるのか',null,true),
  ('株式併合では保有株数が減る','企業イベント・実務','株式併合では保有株数が減る',null,true),
  ('TOBが発表された時に株主が取れる選択肢','企業イベント・実務','TOBが発表された時に株主が取れる選択肢',null,true),
  ('TOB価格と市場価格が完全には一致しないことがある','企業イベント・実務','TOB価格と市場価格が完全には一致しないことがある',null,true),
  ('上場廃止が決まった株を持ち続けるとどうなるのか','企業イベント・実務','上場廃止が決まった株を持ち続けるとどうなるのか',null,true),
  ('株式交換で保有株が別会社株になる場合がある','企業イベント・実務','株式交換で保有株が別会社株になる場合がある',null,true),
  ('合併で保有株の扱いが変わる場合がある','企業イベント・実務','合併で保有株の扱いが変わる場合がある',null,true),
  ('新株予約権が株主に付与されるケース','企業イベント・実務','新株予約権が株主に付与されるケース',null,true),
  ('株式分割などの企業イベントで未約定注文が影響を受ける場合がある','企業イベント・実務','株式分割などの企業イベントで未約定注文が影響を受ける場合がある',null,true),
  ('企業から届く重要なコーポレートアクション通知を放置しない方がいい理由','企業イベント・実務','企業から届く重要なコーポレートアクション通知を放置しない方がいい理由',null,true)
on conflict(title) do update set category=excluded.category,topic_description=excluded.topic_description,source_hint=coalesce(excluded.source_hint,public.useful_tips.source_hint),fact_check_required=true;

create or replace function public.plan_weekly_useful_tips(
  p_week_start date default (date_trunc('week', now() at time zone 'Asia/Tokyo'))::date
) returns setof public.scheduled_posts
language plpgsql security definer set search_path=public as $$
declare
  s public.useful_tip_schedule_settings%rowtype;
  d date;
  candidate timestamptz;
  local_candidate timestamp;
  use_a boolean;
  attempt integer;
begin
  select * into s from public.useful_tip_schedule_settings where id=true;
  if not found or not s.is_active then return; end if;

  for d in
    select day_date from (
      select p_week_start+i as day_date,
        abs(hashtextextended((p_week_start+i)::text||':'||p_week_start::text,0)) as rank_key
      from generate_series(0,6) i
    ) ranked order by rank_key limit s.posts_per_week
  loop
    if exists(select 1 from public.scheduled_posts where schedule_date=d and post_type='useful_tip') then continue; end if;
    use_a := mod(abs(hashtextextended(d::text||':useful_tip_window',0)),2)=0;
    for attempt in 1..40 loop
      if attempt=21 then use_a := not use_a; end if;
      if use_a then
        local_candidate := d+s.window_a_start+floor(random()*extract(epoch from (s.window_a_end-s.window_a_start)+1))*interval '1 second';
      else
        local_candidate := d+s.window_b_start+floor(random()*extract(epoch from (s.window_b_end-s.window_b_start)+1))*interval '1 second';
      end if;
      candidate := local_candidate at time zone s.timezone;
      if exists(
        select 1 from public.scheduled_posts p where p.schedule_date=d
        and p.status in ('pending','running','succeeded')
        and p.scheduled_for between candidate-(s.collision_minutes||' minutes')::interval
                                and candidate+(s.collision_minutes||' minutes')::interval
      ) then continue; end if;
      if exists(
        select 1 from public.posting_blackouts b where b.is_active
        and (candidate at time zone b.timezone)::time between b.start_time and b.end_time
      ) then continue; end if;
      insert into public.scheduled_posts(schedule_date,post_type,slot_no,scheduled_for)
      values(d,'useful_tip',1,candidate) on conflict do nothing;
      exit;
    end loop;
  end loop;
  return query select * from public.scheduled_posts
    where schedule_date between p_week_start and p_week_start+6
      and post_type='useful_tip' order by scheduled_for;
end
$$;

create or replace function public.complete_useful_tip_post(
  p_scheduled_post_id uuid, p_useful_tip_id uuid, p_x_post_id text,
  p_source_urls jsonb, p_model_used text, p_escalated boolean,
  p_input_tokens integer, p_output_tokens integer, p_api_cost numeric
) returns void language plpgsql security definer set search_path=public as $$
begin
  update public.useful_tips set last_used_at=now(),use_count=use_count+1 where id=p_useful_tip_id;
  update public.scheduled_posts set status='succeeded',finished_at=now()
    where id=p_scheduled_post_id and status='running';
  insert into public.post_execution_logs(
    scheduled_post_id,post_type,status,useful_tip_id,x_post_id,message,
    source_urls,verified_at,model_used,escalated_to_sol,input_tokens,output_tokens,api_cost_usd
  ) values (
    p_scheduled_post_id,'useful_tip','succeeded',p_useful_tip_id,p_x_post_id,
    'Verified useful tip posted',p_source_urls,now(),p_model_used,p_escalated,
    p_input_tokens,p_output_tokens,p_api_cost
  );
end
$$;
revoke all on function public.complete_useful_tip_post(uuid,uuid,text,jsonb,text,boolean,integer,integer,numeric) from public;
grant execute on function public.complete_useful_tip_post(uuid,uuid,text,jsonb,text,boolean,integer,integer,numeric) to service_role;

create or replace function public.claim_due_post()
returns setof public.scheduled_posts
language plpgsql security definer set search_path=public as $$
declare claimed_id uuid;
begin
  perform public.plan_daily_posts();
  perform public.plan_weekly_useful_tips();
  select id into claimed_id from public.scheduled_posts
    where status='pending' and scheduled_for<=now()
    order by scheduled_for for update skip locked limit 1;
  if claimed_id is null then return; end if;
  update public.scheduled_posts set status='running',started_at=now(),attempt_count=attempt_count+1
    where id=claimed_id;
  insert into public.post_execution_logs(scheduled_post_id,post_type,status,message)
    select id,post_type,'started','Scheduled post claimed' from public.scheduled_posts where id=claimed_id;
  return query select * from public.scheduled_posts where id=claimed_id;
end
$$;
