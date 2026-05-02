const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');

// mirror: getNotifications(userId)
async function getNotifications(ctx, userId) {
  const uid = userId || (ctx.user && ctx.user.userId);
  if (!uid) return [];
  const sb = getSupabase();
  const { data } = await sb.from('notifications')
    .select('*').eq('user_id', uid)
    .order('created_at', { ascending: false }).limit(30);
  return (data || []).map(n => ({
    id: n.notif_id, type: n.type, message: n.message,
    isRead: !!n.is_read,
    createdAt: n.created_at ? String(n.created_at).substring(0, 10) : ''
  }));
}

// mirror: markNotificationRead(notifId)
async function markNotificationRead(_ctx, notifId) {
  const sb = getSupabase();
  const { error } = await sb.from('notifications').update({ is_read: true }).eq('notif_id', notifId);
  if (error) return fail(error.message);
  return ok();
}

// mirror: markAllNotificationsRead(userId)
async function markAllNotificationsRead(ctx, userId) {
  const uid = userId || (ctx.user && ctx.user.userId);
  if (!uid) return fail('ไม่พบผู้ใช้');
  const sb = getSupabase();
  const { error } = await sb.from('notifications').update({ is_read: true }).eq('user_id', uid).eq('is_read', false);
  if (error) return fail(error.message);
  return ok();
}

// mirror: deleteNotification(notifId)
async function deleteNotification(_ctx, notifId) {
  const sb = getSupabase();
  const { error } = await sb.from('notifications').delete().eq('notif_id', notifId);
  if (error) return fail(error.message);
  return ok();
}

module.exports = { getNotifications, markNotificationRead, markAllNotificationsRead, deleteNotification };
