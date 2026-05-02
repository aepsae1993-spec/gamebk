const { getSupabase } = require('../_lib/supabase');
const { driveDirectLink } = require('../_lib/util');

// mirror: getPetImagesDictionary()
async function getPetImagesDictionary() {
  const sb = getSupabase();
  const { data } = await sb.from('pet_images').select('*');
  const dict = {};
  (data || []).forEach(r => {
    dict[r.pet_type] = [
      driveDirectLink(r.stage1_url || ''),
      driveDirectLink(r.stage2_url || ''),
      driveDirectLink(r.stage3_url || ''),
      driveDirectLink(r.stage4_url || ''),
      driveDirectLink(r.stage5_url || '')
    ];
  });
  return dict;
}

// mirror: getEquipImagesDictionary()
async function getEquipImagesDictionary() {
  const sb = getSupabase();
  const { data } = await sb.from('equip_images').select('equip_id, image_url');
  const dict = {};
  (data || []).forEach(r => {
    if (r.image_url) dict[r.equip_id] = driveDirectLink(r.image_url);
  });
  return dict;
}

// mirror: getMaterialImages()
async function getMaterialImages() {
  const sb = getSupabase();
  const { data } = await sb.from('material_images').select('*');
  const images = (data || [])
    .filter(r => r.image_url)
    .map(r => ({ matKey: r.mat_key, name: r.name || '', imageUrl: driveDirectLink(r.image_url) }));
  return { success: true, images };
}

// mirror: getPetConfigDictionary()
async function getPetConfigDictionary() {
  const sb = getSupabase();
  const { data } = await sb.from('pet_config').select('*');
  if (!data || data.length === 0) return null;
  const pets = {};
  const pools = { C: [], R: [], SR: [], SSR: [], UR: [] };
  data.forEach(r => {
    const rarity = (r.rarity || 'C').toUpperCase();
    pets[r.pet_type] = {
      rarity,
      emojis: [r.emoji1 || '', r.emoji2 || '', r.emoji3 || '', r.emoji4 || '', r.emoji5 || ''],
      names:  [r.name1  || '', r.name2  || '', r.name3  || '', r.name4  || '', r.name5  || '']
    };
    (pools[rarity] || pools.C).push(r.pet_type);
  });
  return { pets, pools };
}

module.exports = {
  getPetImagesDictionary, getEquipImagesDictionary,
  getMaterialImages, getPetConfigDictionary
};
