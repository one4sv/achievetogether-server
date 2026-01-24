import { authenticateUser } from "./middleware/token.js";
import { hasServerPermission } from "./funcs/hasPermission.js";  // если нужно для доп. проверок
import { PERMS } from "./PERMS.js";

export default function (app, supabase) {
  app.get("/getpermissions/:id", authenticateUser(supabase), async (req, res) => {
    try {
      const userId = req.user.id;
      const groupId = req.params.id;

      const { data: currentMember } = await supabase
        .from("chat_members")
        .select("id")
        .eq("chat_id", groupId)
        .eq("user_id", userId)
        .single();

      if (!currentMember) {
        return res.status(403).json({ success: false, error: "Нет доступа к группе" });
      }

      if (!(await hasServerPermission(supabase, groupId, userId, PERMS.manage_roles))) {
        return res.status(403).json({ success: false, error: "У вас нет прав на просмотр/управление ролями" });
      }

      const { data: chat } = await supabase
        .from("chats")
        .select("creator_id")
        .eq("id", groupId)
        .single();

      if (!chat) {
        return res.status(404).json({ success: false, error: "Группа не найдена" });
      }

      const ownerId = chat.creator_id;

      const { data: rawRoles } = await supabase
        .from("chat_roles")
        .select("id, name, permissions, is_editable, desc, is_default, rank")
        .eq("chat_id", groupId);

      const roles = (rawRoles || []).map(r => ({
        role_id: r.id.toString(),
        role_name: r.name,
        permissions: r.permissions || {},
        is_editable:r.is_editable,
        desc:r.desc || "",
        is_default:r.is_default,
        rank:r.rank,
      }));

      const { data: rawMembers } = await supabase
        .from("chat_members")
        .select("user_id, role_id, permission_overrides")
        .eq("chat_id", groupId);

      if (!rawMembers || rawMembers.length === 0) {
        return res.json({ success: true, roles, members: [] });
      }

      const userIds = rawMembers.map(m => m.user_id);
      const { data: users } = await supabase
        .from("users")
        .select("id, username, nick, avatar_url, last_online")
        .in("id", userIds);

      const userMap = {};
      users?.forEach(u => {
        userMap[u.id] = u;
      });

      const rolePermMap = {};
      rawRoles?.forEach(r => {
        rolePermMap[r.id] = r.permissions || {};
      });

      const members = rawMembers.map(rm => {
        const user = userMap[rm.user_id] || {};

        let effectivePerms = {
          change_avatar: false,
          change_name: false,
          change_desc: false,
          pin_messages: false,
          redirect_messages: false,
          delete_others: false,
          manage_roles: false,
          kick_users: false,
          ban_users: false,
          can_invite_users: false,
        };

        if (rm.user_id === ownerId) {
          Object.keys(effectivePerms).forEach(k => {
            effectivePerms[k] = true;
          });
        } else {
          if (rm.role_id) {
            const rolePerms = rolePermMap[rm.role_id] || {};
            Object.assign(effectivePerms, rolePerms);
          }

          const overrides = rm.permission_overrides || {};
          Object.keys(overrides).forEach(k => {
            if (k in effectivePerms) {
              effectivePerms[k] = overrides[k] === true;
            }
          });
        }

        const role = rawRoles?.find(r => r.id === rm.role_id);

        return {
          id: rm.user_id,
          name: user.username || null,
          nick: user.nick || "",
          avatar_url: user.avatar_url || null,
          role_id: rm.role_id ? rm.role_id.toString() : null,
          last_online: user.last_online || null,
          role_name: role ? role.name : "member",
          permissions: effectivePerms,
        };
      });

      res.json({
        success: true,
        roles,
        members,
      });
    } catch (err) {
      console.error("[getPermissions] error:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}