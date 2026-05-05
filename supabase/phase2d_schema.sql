-- ============================================================
-- Phase 2D Schema — Market + Guild + Daily Quest + Weekly Boss
-- ============================================================

-- ============================================================
-- MARKET_LISTINGS — รวมการลงขายทั้งหมด (pet/equipment/material)
-- ============================================================
create table if not exists market_listings (
    market_id      text primary key default ('MK-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    seller_id      text not null references users(user_id) on delete cascade,
    seller_name    text,
    listing_type   text not null check (listing_type in ('pet','equipment','material')),
    -- pet: petItemId อ้างอิง inventory.item_id; equipment: equipItemId; material: mat_key + qty
    pet_item_id    text,
    equip_item_id  text,
    mat_key        text,
    quantity       integer default 1,
    price          integer not null,
    status         text not null default 'listed' check (status in ('listed','sold','cancelled','expired')),
    listed_at      timestamptz default now(),
    expires_at     timestamptz,
    sold_to        text,
    sold_at        timestamptz,
    -- snapshot data ตอนลงขาย (เผื่ออ้างอิงเมื่อ inventory ถูกลบ)
    snapshot       jsonb default '{}'::jsonb
);

create index if not exists market_listings_status_idx on market_listings(status, listing_type);
create index if not exists market_listings_seller_idx on market_listings(seller_id);

-- ============================================================
-- DAILY_QUEST_CONFIG — admin config quests
-- ============================================================
create table if not exists daily_quest_config (
    quest_id        text primary key,
    name            text not null,
    description     text,
    progress_type   text not null,    -- login, submit, pvp_win, gacha, shop_buy, pet_upgrade, ...
    target          integer default 1,
    reward_gold     integer default 0,
    reward_exp      integer default 0,
    is_active       boolean default true
);

-- ============================================================
-- DAILY_QUEST_CLAIMS — เก็บการ claim ต่อวันต่อ user
-- ============================================================
create table if not exists daily_quest_claims (
    user_id      text not null references users(user_id) on delete cascade,
    quest_id     text not null references daily_quest_config(quest_id) on delete cascade,
    claim_date   date not null default current_date,
    claimed_at   timestamptz default now(),
    primary key (user_id, quest_id, claim_date)
);

-- ============================================================
-- WEEKLY_BOSS — boss config + state
-- ============================================================
create table if not exists weekly_boss (
    boss_id          text primary key default ('BOSS-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    name             text not null,
    emoji            text default '🐲',
    image_url        text,
    boss_element     text default 'fire',
    boss_atk         integer default 500,
    boss_reflect     integer default 10,
    max_hp           integer default 100000,
    current_hp       integer default 100000,
    day_of_week      text,                -- 'monday'..'sunday'
    start_time       text,                -- HH:MM
    duration_min     integer default 60,
    reward_gold      integer default 5000,
    reward_souls     integer default 50,
    reward_mat_box   integer default 1,
    reward_equip_box integer default 0,
    status           text default 'pending' check (status in ('pending','active','ended')),
    started_at       timestamptz,
    ended_at         timestamptz
);

-- ============================================================
-- WEEKLY_BOSS_LOG — บันทึกการโจมตี
-- ============================================================
create table if not exists weekly_boss_log (
    log_id       text primary key default ('BL-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    boss_id      text references weekly_boss(boss_id) on delete cascade,
    user_id      text references users(user_id) on delete cascade,
    damage       integer default 0,
    pet_item_id  text,
    attacked_at  timestamptz default now()
);

create index if not exists weekly_boss_log_boss_idx on weekly_boss_log(boss_id);
create index if not exists weekly_boss_log_user_idx on weekly_boss_log(boss_id, user_id);

-- ============================================================
-- GUILDS
-- ============================================================
create table if not exists guilds (
    guild_id     text primary key default ('G-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    name         text not null unique,
    leader_id    text references users(user_id) on delete set null,
    funds        integer default 0,
    exp_total    integer default 0,
    member_limit integer default 10,
    join_mode    text default 'request' check (join_mode in ('open','request','closed')),
    created_at   timestamptz default now()
);

-- ============================================================
-- GUILD_MEMBERS
-- ============================================================
create table if not exists guild_members (
    guild_id      text not null references guilds(guild_id) on delete cascade,
    user_id       text not null references users(user_id) on delete cascade,
    role          text default 'member' check (role in ('leader','officer','member','pending')),
    guild_points  integer default 0,
    joined_at     timestamptz default now(),
    primary key (guild_id, user_id)
);

create unique index if not exists guild_members_user_unique on guild_members(user_id) where role <> 'pending';

-- ============================================================
-- GUILD_CHAT
-- ============================================================
create table if not exists guild_chat (
    chat_id    text primary key default ('GC-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    guild_id   text not null references guilds(guild_id) on delete cascade,
    user_id    text references users(user_id) on delete set null,
    user_name  text,
    message    text,
    sent_at    timestamptz default now()
);

create index if not exists guild_chat_guild_idx on guild_chat(guild_id, sent_at desc);

-- ============================================================
-- GUILD_FARM — farm slots (1 row ต่อ slot)
-- ============================================================
create table if not exists guild_farm (
    farm_id        text primary key default ('GF-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    user_id        text not null references users(user_id) on delete cascade,
    slot_index     integer not null,
    pet_item_id    text,                  -- inventory.item_id ที่ฝากฟาร์ม
    started_at     timestamptz,
    farm_multiplier numeric default 1.0,
    constraint guild_farm_user_slot_unique unique (user_id, slot_index)
);

-- ============================================================
-- SEED — default daily quests
-- ============================================================
insert into daily_quest_config (quest_id, name, description, progress_type, target, reward_gold, reward_exp, is_active) values
    ('q_login',       'เช็คอินรายวัน',         'เข้าระบบในวันนี้',                'login',         1,  100,  50, true),
    ('q_submit_1',    'ส่งงาน 1 ชิ้น',          'ส่งภารกิจในวันนี้ 1 ครั้ง',        'submit',        1,  300, 100, true),
    ('q_submit_3',    'ส่งงาน 3 ชิ้น',          'ส่งภารกิจในวันนี้ 3 ครั้ง',        'submit',        3, 1000, 300, true),
    ('q_pvp_win_3',   'ชนะ PvP 3 ครั้ง',       'เอาชนะการประลอง 3 ครั้งในวันนี้',  'pvp_win',       3,  800, 200, true),
    ('q_gacha_1',     'หมุนกาชา 1 ครั้ง',       'สุ่มกาชา 1 ครั้งในวันนี้',         'gacha',         1,  200, 100, true),
    ('q_pet_upgrade', 'ตีบวกสัตว์เลี้ยง',         'ตีบวกคู่หู 1 ครั้ง',               'pet_upgrade',   1,  500, 150, true)
on conflict (quest_id) do nothing;
