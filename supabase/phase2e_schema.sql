-- ============================================================
-- Phase 2E Schema — Guild War (สงครามกิลด์)
-- ============================================================
-- War lifecycle: scheduled → active → ended
-- ทุกกิลด์ในระบบมีป้อม 1 ป้อม (HP เริ่มต้น 20,000)
-- ป้อมมี 3 slot ให้สมาชิกวาง pet ป้องกัน
-- ผู้เล่นเข้าร่วมส่ง 3 pet (ใช้ active ทีละตัว)
-- ============================================================

create table if not exists guild_wars (
    war_id          text primary key default ('WAR-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    name            text default 'สงครามกิลด์',
    start_at        timestamptz,            -- เวลาเริ่ม (จะ activate auto หรือ admin start)
    duration_min    integer default 60,
    status          text not null default 'scheduled' check (status in ('scheduled','active','ended','cancelled')),
    reward_gold     integer default 5000,
    reward_souls    integer default 50,
    reward_gp_win   integer default 100,
    reward_gp_lose  integer default 30,
    fortress_max_hp integer default 20000,
    winner_guild_id text,
    created_at      timestamptz default now(),
    ended_at        timestamptz
);

create table if not exists guild_war_fortresses (
    war_id        text not null references guild_wars(war_id) on delete cascade,
    guild_id      text not null references guilds(guild_id) on delete cascade,
    fortress_hp   integer default 20000,
    max_hp        integer default 20000,
    primary key (war_id, guild_id)
);

create table if not exists guild_war_defenders (
    war_id      text not null references guild_wars(war_id) on delete cascade,
    guild_id    text not null references guilds(guild_id) on delete cascade,
    slot        integer not null check (slot between 1 and 3),
    user_id     text references users(user_id) on delete set null,
    pet_item_id text,
    current_hp  integer default 0,
    max_hp      integer default 0,
    cd_until    bigint default 0,        -- unix ms
    primary key (war_id, guild_id, slot)
);

create table if not exists guild_war_participants (
    war_id        text not null references guild_wars(war_id) on delete cascade,
    user_id       text not null references users(user_id) on delete cascade,
    guild_id      text references guilds(guild_id) on delete set null,
    pet_ids       jsonb default '[]'::jsonb,    -- ['INV-aaa','INV-bbb','INV-ccc']
    active_pet    text,                          -- pet_item_id ของตัวที่ใช้อยู่
    damage_dealt  integer default 0,
    last_attack_cd bigint default 0,
    joined_at     timestamptz default now(),
    primary key (war_id, user_id)
);

create table if not exists guild_war_log (
    log_id          text primary key default ('WL-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    war_id          text references guild_wars(war_id) on delete cascade,
    attacker_id     text references users(user_id) on delete set null,
    attacker_name   text,
    attacker_guild  text,
    target_guild    text,
    action          text,           -- attack_fortress, attack_defender, place_defender, use_item
    damage          integer default 0,
    target_slot     integer,
    details         text,
    timestamp       timestamptz default now()
);

create index if not exists guild_war_log_war_idx on guild_war_log(war_id, timestamp desc);
create index if not exists guild_war_participants_war_idx on guild_war_participants(war_id);
