import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
    app.get('/updatehabit', (req, res) => {
        res.send("Habit update backend is working");
    });

    app.post('/updatehabit', authenticateUser(supabase), async (req, res) => {
        const { habit_id, table, ...updateData } = req.body;
        const field = Object.keys(updateData)[0];
        const value = updateData[field];
        const { id: user_id } = req.user;

        if (!user_id) {
            return res.status(401).json({ error: 'Пользователь не аутентифицирован' });
        }
        if (!habit_id) {
            return res.status(400).json({ error: 'ID привычки обязателен' });
        }

        try {
            const { data: habit, error: habitError } = await supabase
                .from('habits')
                .select('user_id')
                .eq('id', habit_id)
                .single();

            if (habitError || !habit) {
                return res.status(404).json({ error: 'Привычка не найдена' });
            }
            if (habit.user_id !== user_id) {
                return res.status(403).json({ error: 'Нет доступа к этой привычке' });
            }

            let validFields = [];
            if (table === 'habits') {
                validFields = [
                    'name', 'desc', 'start_date', 'end_date', 'ongoing',
                    'periodicity', 'chosen_days', 'start_time', 'end_time',
                    'pinned', 'tag', 'is_archived'
                ];
            } else if (table === 'habits_settings') {
                validFields = ['metric_type', 'schedule'];
            } else {
                return res.status(400).json({ error: 'Недопустимая таблица' });
            }

            if (!validFields.includes(field)) {
                return res.status(400).json({ error: 'Недопустимое поле для обновления' });
            }

            let formattedValue = value;
            if (field === 'start_date' || field === 'end_date') {
                formattedValue = value ? new Date(value).toISOString().split('T')[0] : null;
            }

            // === НОВАЯ ЛОГИКА: очистка chosen_days на backend ===
            let updatePayload = { [field]: formattedValue };

            if (table === 'habits' && field === 'periodicity' && formattedValue !== 'weekly') {
                updatePayload.chosen_days = null;   // ← автоматический сброс
            }

            let needId = habit_id;
            if (table === 'habits_settings') {
                const { data: setting, error: setting_error } = await supabase
                    .from('habits_settings')
                    .select('id')
                    .eq('habit_id', habit_id)
                    .single();

                if (setting_error) {
                    console.error('Ошибка при поиске настроек:', setting_error);
                    return res.status(500).json({ error: 'Ошибка сервера при поиске настроек' });
                }
                if (!setting) {
                    return res.status(404).json({ error: 'Настройки не найдены' });
                }
                needId = setting.id;
            }

            const { error } = await supabase
                .from(table)
                .update(updatePayload)   // ← обновляем одним запросом (возможно 2 поля)
                .eq('id', needId);

            if (error) throw error;

            console.log(`✅ Обновлено: ${field}${updatePayload.chosen_days !== undefined ? ' + chosen_days=null' : ''}`);
            return res.status(200).json({ success: true });
        } catch (err) {
            console.error('Ошибка при обновлении привычки:', err);
            return res.status(500).json({ error: 'Ошибка сервера при обновлении привычки' });
        }
    });
}