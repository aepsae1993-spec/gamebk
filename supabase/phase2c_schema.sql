-- ============================================================
-- LMS Quest - Phase 2C Schema (Skills + Equipment + Materials)
-- รันหลัง phase2_schema.sql
-- ============================================================

-- ============================================================
-- PET_SKILLS — ตารางนิยามสกิลทั้งหมด
-- ============================================================
create table if not exists pet_skills (
    skill_id        text primary key,
    name            text not null,
    type            text not null check (type in ('passive','active')),
    effect          text not null,            -- atkBoost, hpBoost, defBoost, spdBoost, lifeSteal, thorns, lucky, fireStrike, iceShield, heal, reflect, debuff, thunderBolt, revive
    value           numeric default 0,
    description     text,
    min_rarity      text default 'C',
    cooldown        integer default 0,        -- จำนวนไฟต์ระหว่างใช้
    reroll_weight   integer default 100
);

-- ============================================================
-- PET_LEARNED_SKILLS — สกิลที่ pet ตัวนั้นเรียนรู้แล้ว
-- ============================================================
create table if not exists pet_learned_skills (
    learned_id     text primary key default ('LS-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    pet_item_id    text not null,           -- inventory.item_id หรือ 'equipped_<userId>' (legacy)
    owner_user_id  text references users(user_id) on delete cascade,
    skill_id       text references pet_skills(skill_id) on delete cascade,
    skill_type     text not null check (skill_type in ('passive','active')),
    source         text default 'gacha',
    acquired_at    timestamptz default now()
);

create index if not exists pet_learned_skills_pet_idx on pet_learned_skills(pet_item_id);
create index if not exists pet_learned_skills_owner_idx on pet_learned_skills(owner_user_id);

-- ============================================================
-- EQUIPMENT_CONFIG — สูตร crafting + base stats
-- ============================================================
create table if not exists equipment_config (
    equip_id          text primary key,
    name              text,
    slot              text not null check (slot in ('weapon','armor','necklace','ring','shoes')),
    rarity            text default 'C',
    atk_bonus         integer default 0,
    hp_bonus          integer default 0,
    def_bonus         integer default 0,
    spd_bonus         integer default 0,
    lifesteal_pct     integer default 0,
    reflect_pct       integer default 0,
    armor_pen         integer default 0,
    description       text
);

-- ============================================================
-- EQUIP_INVENTORY — อุปกรณ์ที่ผู้เล่นมี (รวมที่ยังไม่สวมใส่)
-- ============================================================
create table if not exists equip_inventory (
    equip_item_id  text primary key default ('EQ-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    user_id        text not null references users(user_id) on delete cascade,
    equip_id       text references equipment_config(equip_id) on delete cascade,
    rolled_stats   jsonb default '{}'::jsonb,    -- เผื่อ stat สุ่มเฉพาะตัว
    created_at     timestamptz default now()
);

create index if not exists equip_inventory_user_idx on equip_inventory(user_id);

-- ============================================================
-- PET_EQUIPMENT — slot ที่สวมใส่ของ pet ปัจจุบัน
-- (1 user มี 1 slot ของแต่ละประเภท: weapon/armor/necklace/ring/shoes)
-- ============================================================
create table if not exists pet_equipment (
    record_id      text primary key default ('PE-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    user_id        text not null references users(user_id) on delete cascade,
    pet_item_id    text,                    -- (optional) inventory.item_id ที่ใส่อยู่
    equip_item_id  text references equip_inventory(equip_item_id) on delete cascade,
    slot           text not null check (slot in ('weapon','armor','necklace','ring','shoes')),
    equipped_at    timestamptz default now(),
    constraint pet_equipment_user_slot_unique unique (user_id, slot)
);

-- ============================================================
-- CRAFTING_MATERIALS — วัตถุดิบของผู้เล่น (mat_iron, mat_leather, ...)
-- ============================================================
create table if not exists crafting_materials (
    user_id    text not null references users(user_id) on delete cascade,
    mat_key    text not null,        -- mat_iron, mat_leather, mat_gem, mat_fabric, mat_essence
    quantity   integer default 0,
    primary key (user_id, mat_key)
);

-- ============================================================
-- SEED — 25 default skills
-- ============================================================
insert into pet_skills (skill_id, name, type, effect, value, description, min_rarity, cooldown, reroll_weight) values
    -- PASSIVE
    ('SKL_P01','พลังโจมตี+เล็ก','passive','atkBoost',5,'เพิ่มพลังโจมตี 5%','C',0,100),
    ('SKL_P02','พลังโจมตี+กลาง','passive','atkBoost',10,'เพิ่มพลังโจมตี 10%','R',0,60),
    ('SKL_P03','พลังโจมตี+ใหญ่','passive','atkBoost',15,'เพิ่มพลังโจมตี 15%','SR',0,30),
    ('SKL_P04','สุขภาพ+เล็ก','passive','hpBoost',5,'เพิ่ม HP สูงสุด 5%','C',0,100),
    ('SKL_P05','สุขภาพ+กลาง','passive','hpBoost',10,'เพิ่ม HP สูงสุด 10%','R',0,60),
    ('SKL_P06','สุขภาพ+ใหญ่','passive','hpBoost',15,'เพิ่ม HP สูงสุด 15%','SR',0,30),
    ('SKL_P07','เกราะ+เล็ก','passive','defBoost',10,'เพิ่ม DEF +10','C',0,100),
    ('SKL_P08','เกราะ+กลาง','passive','defBoost',25,'เพิ่ม DEF +25','R',0,60),
    ('SKL_P09','เกราะ+ใหญ่','passive','defBoost',50,'เพิ่ม DEF +50','SR',0,30),
    ('SKL_P10','ว่องไว+เล็ก','passive','spdBoost',10,'เพิ่ม SPD +10','C',0,100),
    ('SKL_P11','ว่องไว+กลาง','passive','spdBoost',25,'เพิ่ม SPD +25','R',0,60),
    ('SKL_P12','ว่องไว+ใหญ่','passive','spdBoost',50,'เพิ่ม SPD +50','SR',0,30),
    ('SKL_P13','ดูดเลือด','passive','lifeSteal',10,'ดูด HP 10% ของดาเมจที่สร้าง (CD 2 ไฟต์)','SR',2,25),
    ('SKL_P14','หนามกระบอง','passive','thorns',10,'สะท้อนดาเมจ 10% เมื่อโดนตี (CD 3 ไฟต์)','R',3,50),
    ('SKL_P15','โชคดี','passive','lucky',20,'โอกาสดรอปไอเทมเพิ่ม 20%','C',0,80),
    -- ACTIVE
    ('SKL_A01','เพลิงทะลวง','active','fireStrike',150,'โจมตีด้วยไฟ ดาเมจ 150%','C',3,100),
    ('SKL_A02','โล่น้ำแข็ง','active','iceShield',50,'กันดาเมจ 50% ในรอบถัดไป','R',5,60),
    ('SKL_A03','ฟื้นฟูเล็ก','active','heal',20,'ฟื้นฟู HP 20%','C',3,100),
    ('SKL_A04','ฟื้นฟูใหญ่','active','heal',40,'ฟื้นฟู HP 40%','SR',5,30),
    ('SKL_A05','คลั่งเลือด','active','atkBoost',50,'เพิ่มพลังโจมตี 50% ในรอบนี้','R',5,60),
    ('SKL_A06','กระจกสะท้อน','active','reflect',100,'สะท้อนดาเมจ 100% ครั้งเดียว','SR',5,30),
    ('SKL_A07','พิษร้าย','active','debuff',20,'ลดพลังโจมตีศัตรู 20%','R',3,60),
    ('SKL_A08','สายฟ้าฟาด','active','thunderBolt',200,'ดาเมจ 200% ทะลุเกราะ DEF','SSR',7,15),
    ('SKL_A09','คืนชีพ','active','revive',30,'คืนชีพด้วย 30% HP เมื่อเลือดหมด','SSR',10,10),
    ('SKL_A10','สะท้อนดาเมจ UR','active','reflect',200,'สะท้อนดาเมจ 200% (UR)','UR',5,5)
on conflict (skill_id) do nothing;

-- ============================================================
-- SEED — equipment config (default 25 ชิ้น 5 rarity × 5 slot)
-- รันคล้ายกับ equip_images แต่เพิ่ม stats
-- ============================================================
insert into equipment_config (equip_id, name, slot, rarity, atk_bonus, hp_bonus, def_bonus, spd_bonus, lifesteal_pct, reflect_pct, armor_pen) values
    -- C
    ('weapon_c','⚔️ ดาบเหล็กกิล','weapon','C',  10,  0,  0,  0,  0,  0,  0),
    ('armor_c', '🛡️ เกราะหนังสัตว์','armor','C',   0, 50, 10,  0,  0,  0,  0),
    ('necklace_c','📿 สร้อยอัญมณี','necklace','C', 0,  0,  0,  5,  0,  0,  0),
    ('ring_c',  '💍 แหวนพลัง','ring','C',           0,  0,  0,  0,  3,  0,  0),
    ('shoes_c', '👟 รองเท้าเวท','shoes','C',         0,  0,  0, 10,  0,  0,  0),
    -- R
    ('weapon_r','⚔️ ดาบมังกรเหล็ก','weapon','R', 25,  0,  0,  0,  0,  0,  5),
    ('armor_r', '🛡️ เกราะมังกร','armor','R',     0,120, 25,  0,  0,  5,  0),
    ('necklace_r','📿 สร้อยจันทรา','necklace','R',0, 30,  0, 12,  0,  0,  0),
    ('ring_r',  '💍 แหวนสายฟ้า','ring','R',       0,  0,  0,  0,  7,  5,  0),
    ('shoes_r', '👟 รองเท้าสายลม','shoes','R',     0,  0,  5, 25,  0,  0,  0),
    -- SR
    ('weapon_sr','⚔️ ดาบเพลิงนรก','weapon','SR',50,  0,  0,  0,  0,  0, 12),
    ('armor_sr', '🛡️ เกราะจักรพรรดิ','armor','SR',0,250, 50,  0,  0, 10,  0),
    ('necklace_sr','📿 สร้อยดาวตก','necklace','SR',0,80,  0, 20,  0,  0,  0),
    ('ring_sr',  '💍 แหวนราชัน','ring','SR',      0,  0,  0,  0, 15, 10,  0),
    ('shoes_sr', '👟 รองเท้าสุริยัน','shoes','SR',  0,  0, 10, 50,  0,  0,  0),
    -- SSR
    ('weapon_ssr','⚔️ ดาบเทพสังหาร','weapon','SSR',100,  0, 0, 0,   0,  0, 25),
    ('armor_ssr','🛡️ เกราะเทพสวรรค์','armor','SSR',  0,500,100, 0,  0, 20,  0),
    ('necklace_ssr','📿 สร้อยเทพจันทร์','necklace','SSR',0,150,0,40, 0,  0,  0),
    ('ring_ssr','💍 แหวนเทพเจ้า','ring','SSR',      0, 0,  0,  0, 25, 20,  0),
    ('shoes_ssr','👟 รองเท้าเทพพายุ','shoes','SSR',  0, 0, 25,100,  0,  0,  0),
    -- UR
    ('weapon_ur','⚔️ ดาบพิฆาตเทพ','weapon','UR',  200,  0, 0, 0,   0,  0, 50),
    ('armor_ur','🛡️ เกราะจักรวาล','armor','UR',     0,1000,200, 0, 0, 35,  0),
    ('necklace_ur','📿 สร้อยดวงดาว','necklace','UR', 0,300,  0,80,  0,  0,  0),
    ('ring_ur','💍 แหวนสรรพสิ่ง','ring','UR',        0,  0,  0,  0,40, 35,  0),
    ('shoes_ur','👟 รองเท้าเวลา','shoes','UR',       0,  0, 50,200,  0,  0,  0)
on conflict (equip_id) do nothing;
