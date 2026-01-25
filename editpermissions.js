import { authenticateUser } from "./middleware/token.js";
import { hasServerPermission } from "./funcs/hasPermission.js";
import { PERMS } from "./PERMS.js";

const PERMISSION_KEYS = [
  "change_avatar",
  "change_name",
  "change_desc",
  "manage_roles",
  "can_invite_users",
  "kick_users",
  "ban_users",
  "delete_others",
  "pin_messages",
  "redirect_messages"
];

export default function (app, supabase) {
  // Существующий GET /getpermissions/:id остаётся без изменений

  // Новый POST /editpermissions/:id — обработка массива изменений
  app.post("/editpermissions/:id", authenticateUser(supabase), async (req, res) => {
    const userId = req.user.id;
    const groupId = req.params.id;
    const changes = req.body;

    if (!Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({ success: false, error: "Нет изменений для применения" });
    }

    try {
      // Проверка доступа к группе
      const { data: member } = await supabase
        .from("chat_members")
        .select("id")
        .eq("chat_id", groupId)
        .eq("user_id", userId)
        .single();

      if (!member) {
        return res.status(403).json({ success: false, error: "Нет доступа к группе" });
      }

      // Получаем владельца группы
      const { data: chat } = await supabase
        .from("chats")
        .select("creator_id")
        .eq("id", groupId)
        .single();

      if (!chat) {
        return res.status(404).json({ success: false, error: "Группа не найдена" });
      }

      const isOwner = userId === chat.creator_id;

      // Проверка прав: владелец может всё, иначе нужен manage_roles
      if (!isOwner && !(await hasServerPermission(supabase, groupId, userId, PERMS.manage_roles))) {
        return res.status(403).json({ success: false, error: "Нет прав на управление ролями и разрешениями" });
      }

      // Получаем все роли группы для проверок rank и is_editable
      const { data: rawRoles } = await supabase
        .from("chat_roles")
        .select("id, rank, is_editable")
        .eq("chat_id", groupId);

      const roleMap = {};
      rawRoles?.forEach(r => {
        roleMap[r.id] = { rank: r.rank, is_editable: r.is_editable };
      });

      // Текущий ранг пользователя (для проверки «выше ли ранг»)
      const { data: myMember } = await supabase
        .from("chat_members")
        .select("role_id")
        .eq("chat_id", groupId)
        .eq("user_id", userId)
        .single();

      const myRoleRank = myMember?.role_id ? roleMap[myMember.role_id]?.rank || 0 : 0;
      const effectiveMyRank = isOwner ? 9999 : myRoleRank; // владелец всегда выше всех

      // Обрабатываем каждое изменение
      const errors = [];

      for (const change of changes) {
        const { target, target_id, label, value } = change;

        try {
          if (target === "group") {
            if (label === "default_role_id") {
              if (typeof value !== "string" && value !== null) throw new Error("Неверный тип default_role_id");

              // Сбрасываем is_default у всех ролей
              await supabase
                .from("chat_roles")
                .update({ is_default: false })
                .eq("chat_id", groupId);

              // Устанавливаем новую дефолтную роль (если указана)
              if (value) {
                await supabase
                  .from("chat_roles")
                  .update({ is_default: true })
                  .eq("id", value)
                  .eq("chat_id", groupId);
              }
            }
          } else if (target === "role") {
            const roleId = target_id;
            const roleInfo = roleMap[roleId];

            if (!roleInfo) throw new Error("Роль не найдена");

            // Проверка прав на редактирование роли
            if (!isOwner) {
              if (!roleInfo.is_editable) throw new Error("Роль не редактируемая");
              if (effectiveMyRank <= roleInfo.rank) throw new Error("Недостаточно высокий ранг для редактирования этой роли");
            }

            if (label === "role_name") {
              if (typeof value !== "string") throw new Error("Неверный тип имени роли");
              await supabase.from("chat_roles").update({ name: value }).eq("id", roleId);
            } else if (label === "rank") {
              if (typeof value !== "number" || value < 1 || value > 99) throw new Error("Неверный ранг");
              await supabase.from("chat_roles").update({ rank: value }).eq("id", roleId);
            } else if (label === "desc") {
              await supabase.from("chat_roles").update({ desc: value ?? null }).eq("id", roleId);
            } else if (PERMISSION_KEYS.includes(label)) {
              if (typeof value !== "boolean") throw new Error("Разрешение должно быть boolean");
              const { data: role } = await supabase.from("chat_roles").select("permissions").eq("id", roleId).single();
              const perms = role?.permissions || {};
              perms[label] = value;
              await supabase.from("chat_roles").update({ permissions: perms }).eq("id", roleId);
            }
          } else if (target === "member") {
            const memberUserId = target_id;

            // Проверка существования участника
            const { data: targetMember } = await supabase
              .from("chat_members")
              .select("role_id, user_id")
              .eq("chat_id", groupId)
              .eq("user_id", memberUserId)
              .single();

            if (!targetMember) throw new Error("Участник не найден");

            // Нельзя редактировать владельца (кроме как владельцем) и себя
            if (targetMember.user_id === chat.creator_id && !isOwner) throw new Error("Нельзя редактировать владельца");
            if (targetMember.user_id === userId) throw new Error("Нельзя редактировать себя");

            // Проверка ранга
            const targetRoleRank = targetMember.role_id ? roleMap[targetMember.role_id]?.rank || 0 : 0;
            if (!isOwner && effectiveMyRank <= targetRoleRank) {
              throw new Error("Недостаточно высокий ранг для редактирования этого участника");
            }

            if (label === "role_id") {
              if (typeof value !== "string" && value !== null) throw new Error("Неверный тип role_id");
              await supabase
                .from("chat_members")
                .update({ role_id: value || null })
                .eq("user_id", memberUserId)
                .eq("chat_id", groupId);
            } else if (PERMISSION_KEYS.includes(label)) {
              if (typeof value !== "boolean") throw new Error("Override разрешения должен быть boolean");
              const { data: memberData } = await supabase
                .from("chat_members")
                .select("permission_overrides")
                .eq("user_id", memberUserId)
                .eq("chat_id", groupId)
                .single();

              const overrides = memberData?.permission_overrides || {};
              overrides[label] = value;
              await supabase
                .from("chat_members")
                .update({ permission_overrides: overrides })
                .eq("user_id", memberUserId)
                .eq("chat_id", groupId);
            }
          }
        } catch (changeError) {
          errors.push({ change, error: changeError.message });
        }
      }

      if (errors.length > 0) {
        return res.status(400).json({ success: false, error: "Частичные ошибки при применении изменений", details: errors });
      }

      res.json({ success: true });
    } catch (err) {
      console.error("[editpermissions] error:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}