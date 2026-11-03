-- 電話番AI のデータベース（Supabase の「SQL Editor」に貼り付けて「Run」）
--
-- ここに入るのは、通話の記録・困りごと・協力者などの機微な情報です。
-- そのため、すべての表で RLS（行ごとの読み書きの制限）をオンにし、許可ルールは1つも作りません。
-- こうすると、ブラウザ用の公開キー（anon / publishable）では一切読み書きできず、
-- サーバーだけが秘密のキー（secret / service_role）で読み書きできます。

-- 通話の記録（end_call のとき）
create table if not exists calls (
  id          uuid primary key default gen_random_uuid(),
  call_id     text not null unique,          -- 1回の通話を表すID（サーバーが発行）
  user_name   text not null,                 -- 本人の呼び名（例：ハナコさん）
  call_date   text not null,                 -- 例：11月4日 水曜日
  health      text,                          -- good / so_so / unwell / urgent / unknown
  today_plan  text,
  needs       jsonb not null default '[]',
  summary     text,
  created_at  timestamptz not null default now()
);

-- 困りごと（request_help のとき。本人が同意したものだけ）
create table if not exists help_requests (
  id             uuid primary key default gen_random_uuid(),
  call_id        text not null,
  user_name      text not null,
  area           text,                       -- 本人の地区（例：国見町）。住所は入れない
  category       text not null,              -- 通院の送り迎え / 買い物 / 畑や庭の作業 / 家の中の力仕事 / その他
  detail         text not null,
  when_text      text,                       -- 例：木曜の10時ごろ
  where_text     text,                       -- 行き先（例：〇〇医院）
  consent_quote  text not null,              -- 本人が同意した言葉そのまま
  status         text not null default 'searching',  -- searching / matched / not_found
  created_at     timestamptz not null default now()
);

-- 協力者（社協などで確認済みの人だけを登録する前提）
create table if not exists helpers (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,               -- 呼び名（例：田中さん）
  can_do        text[] not null default '{}',-- できること（request_help の category と同じ言葉）
  area          text,                        -- 住んでいる地区
  available     text,                        -- 空いている曜日・時間（例：火・木の午前）
  has_car       boolean not null default false,
  line_user_id  text,                        -- LINE のユーザーID（U で始まる）。デモでは協力者役の人だけ入れる
  points        integer not null default 0,  -- ありがとうポイント
  created_at    timestamptz not null default now()
);

-- 誰に声をかけたか（調整係が使う）
create table if not exists offers (
  id               uuid primary key default gen_random_uuid(),
  help_request_id  uuid not null references help_requests(id) on delete cascade,
  helper_id        uuid not null references helpers(id) on delete cascade,
  reason           text,                     -- 選んだ理由（状況画面に表示）
  message          text,                     -- 送った依頼文
  status           text not null default 'asked',  -- asked / accepted / declined / closed
  created_at       timestamptz not null default now()
);

alter table calls          enable row level security;
alter table help_requests  enable row level security;
alter table helpers        enable row level security;
alter table offers         enable row level security;

-- デモ用の協力者（架空の人です）。調整係が「なぜこの人か」を選べるように、条件をばらしてあります
insert into helpers (display_name, can_do, area, available, has_car)
select * from (values
  ('山口さん', array['通院の送り迎え','買い物'],            '国見町', '土・日',       true),
  ('森さん',   array['買い物','畑や庭の作業'],               '国見町', '平日の午前',   false),
  ('田中さん', array['通院の送り迎え','家の中の力仕事'],     '国見町', '火・木の午前', true)
) as v(display_name, can_do, area, available, has_car)
where not exists (select 1 from helpers);
