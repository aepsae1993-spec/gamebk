// ============================================================
// activeBuff string helpers (mirror code.gs เดิม)
//   - "buff1,buff2,pvp_extra_battle:3,guildPerm_atk:5"
// ============================================================

function hasBuff(str, name) {
  if (!str) return false;
  return String(str).split(',').includes(name);
}

function addBuff(str, name) {
  if (!str) return name;
  const arr = String(str).split(',');
  if (!arr.includes(name)) arr.push(name);
  return arr.join(',');
}

function removeBuff(str, name) {
  if (!str) return '';
  return String(str).split(',').filter(b => b !== name).join(',');
}

// PvP item counter: "pvp_extra_battle:3"
function getPvpCount(str, key) {
  if (!str) return 0;
  for (const b of String(str).split(',')) {
    if (b.startsWith('pvp_' + key + ':')) return parseInt(b.split(':')[1]) || 0;
  }
  return 0;
}

function setPvpCount(str, key, count) {
  const prefix = 'pvp_' + key + ':';
  const arr = str ? String(str).split(',').filter(b => b && !b.startsWith(prefix)) : [];
  if (count > 0) arr.push(prefix + count);
  return arr.join(',');
}

module.exports = { hasBuff, addBuff, removeBuff, getPvpCount, setPvpCount };
