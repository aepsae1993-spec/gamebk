-- ============================================================
-- LMS Quest - Phase 2 Schema (Pet / Inventory)
-- ============================================================
-- รัน script นี้ใน SQL Editor หลังจาก phase 1 schema.sql แล้ว
-- ============================================================

-- ============================================================
-- PET_STATS  (1 row ต่อ user — เก็บสถานะเกม)
-- ============================================================
create table if not exists pet_stats (
    user_id              text primary key references users(user_id) on delete cascade,
    exp_offset           integer default 0,             -- bonus exp (จาก reward)
    current_hp           integer default 0,             -- 0 = full hp ตาม maxHp
    levels_lost_today    integer default 0,
    last_attacked_date   date,
    coins_spent          integer default 0,
    pet_type             text default 'dog',            -- ตัว equipped (legacy fallback)
    shield_expiry        bigint default 0,              -- unix ms
    battle_count_today   integer default 0,
    daily_battles        jsonb default '[]'::jsonb,
    last_battle_date     date,
    custom_name          text default '',
    active_buff          text default '',               -- comma-separated buff string เหมือนเดิม
    free_coins           integer default 0,             -- bonus coins (จาก reward)
    element              text default 'normal',
    daily_items          jsonb default '{}'::jsonb,     -- { itemKey: countUsedToday }
    enhance_level        integer default 0,
    inventory_limit      integer default 5,
    souls                integer default 0,
    pet_aura             text default '',
    pet_title            text default '',
    updated_at           timestamptz default now()
);

-- ============================================================
-- INVENTORY  (กระเป๋า — หลาย row ต่อ user)
-- categories: 'pets', 'equipped', 'items', 'gears'
-- ============================================================
create table if not exists inventory (
    item_id        text primary key default ('IT-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    user_id        text not null references users(user_id) on delete cascade,
    category       text not null check (category in ('pets','equipped','items','gears')),
    item_key       text,                            -- เช่น 'dog', 'phoenix', 'iron_ore', 'weapon_c'
    element        text default 'normal',
    enhance_level  integer default 0,
    quantity       integer default 1,
    pet_exp        integer default 0,
    pet_level      integer default 0,
    is_locked      boolean default false,           -- ติดตลาด/ฟาร์ม → ห้าม discard/equip
    locked_reason  text default '',
    custom_name    text default '',                 -- ตั้งชื่อตัวเอง
    pet_aura       text default '',
    pet_title      text default '',
    metadata       jsonb default '{}'::jsonb,       -- เผื่อขยาย field
    created_at     timestamptz default now()
);

create index if not exists inventory_user_idx on inventory(user_id);
create index if not exists inventory_user_category_idx on inventory(user_id, category);

-- 1 user ใส่สัตว์ equipped ได้ตัวเดียว
create unique index if not exists inventory_one_equipped_per_user
    on inventory (user_id) where category = 'equipped';

-- ============================================================
-- helpful comments
-- ============================================================
comment on table pet_stats is 'สถานะผู้เล่นใน Pet/Game system — 1:1 กับ users (เฉพาะ student)';
comment on table inventory is 'กระเป๋าผู้เล่น — เก็บ pets/equipped/items/gears';
comment on column inventory.category is 'pets=สัตว์ในกระเป๋า, equipped=สวมใส่อยู่, items=ไอเทมใช้, gears=อุปกรณ์';
