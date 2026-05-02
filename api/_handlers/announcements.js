const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');

// mirror: createAnnouncement(data)
async function createAnnouncement(ctx, data) {
  if (!ctx.user || !['Admin','Teacher'].includes(ctx.user.role)) return fail('สิทธิ์ไม่เพียงพอ');
  if (!data || !data.title) return fail('ระบุหัวข้อประกาศ');
  const sb = getSupabase();
  const { error } = await sb.from('announcements').insert({
    title: data.title,
    content: data.content || '',
    scope: data.scope || 'global',
    author_id: data.authorId || ctx.user.userId,
    author_name: data.authorName || ctx.user.name
  });
  if (error) return fail(error.message);
  return ok({ message: 'ลงประกาศสำเร็จ' });
}

// mirror: getAnnouncements()
async function getAnnouncements() {
  const sb = getSupabase();
  const { data } = await sb.from('announcements')
    .select('*').order('created_at', { ascending: false });
  return (data || []).map(a => ({
    id: a.id, title: a.title, content: a.content || '',
    Scope: a.scope || 'global', authorId: a.author_id || '',
    authorName: a.author_name || '',
    createdAt: a.created_at ? String(a.created_at).substring(0, 10) : ''
  }));
}

module.exports = { createAnnouncement, getAnnouncements };
