export async function hasServerPermission(supabase, chatId, userId, permKey) {
  // Владелец чата может всё
  const { data: chat } = await supabase
    .from("chats")
    .select("creator_id")
    .eq("id", chatId)
    .single();

  if (chat?.creator_id === userId) return true;

  // Участник и не заблокирован
  const { data: member } = await supabase
    .from("chat_members")
    .select("is_blocked, role_id, permission_overrides")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .single();

  if (!member || member.is_blocked) return false;

  let rolePerms = {};
  if (member.role_id) {
    const { data: role } = await supabase
      .from("chat_roles")
      .select("permissions")
      .eq("id", member.role_id)
      .single();
    rolePerms = role?.permissions || {};
  }

  const overrides = member.permission_overrides || {};

  // overrides > role > false
  if (permKey in overrides) return overrides[permKey] === true;
  return rolePerms[permKey] === true;
}