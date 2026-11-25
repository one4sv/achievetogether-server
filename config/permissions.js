export const PERMS = {
  send_messages: "send_messages",
  plan_complete: "plan_complete",
  plan_comment: "plan_comment",
  goal_progress: "goal_progress",
  habit_complete: "habit_complete",
  habit_comment: "habit_comment",
  habit_edit_blocks: "habit_edit_blocks",
  habit_edit_info: "habit_edit_info",
  habit_invite: "habit_invite",
  change_avatar: "change_avatar",
  change_name: "change_name",
  change_desc: "change_desc",
  pin_messages: "pin_messages",
  redirect_messages: "redirect_messages",
  delete_others: "delete_others",
  manage_roles: "manage_roles",
  kick_users: "kick_users",
  ban_users: "ban_users",
  can_invite_users: "can_invite_users",
};

// These actions existed before group-level restrictions; missing keys preserve access.
export const defaultPermission = key => ["send_messages", "plan_complete", "plan_comment", "goal_progress"].includes(key);
export const rolePermission = (permissions, key) => typeof permissions?.[key] === "boolean" ? permissions[key] : defaultPermission(key);
