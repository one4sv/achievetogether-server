import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
    app.get('/updatehabit', (req, res) => {
        res.send("Habit update backend is working");
    });

    app.post('/updatehabit', authenticateUser(supabase), async (req, res) => {
        const { habit_id, ...updateData } = req.body;
        const field = Object.keys(updateData)[0];
        const value = updateData[field];
        const { id: user_id } = req.user;

        if (!user_id) {
            return res.status(401).json({ error: 'Пользователь не аутентифицирован' });
        }

        if (!habit_id) {
            return res.status(400).json({ error: 'ID привычки обязателен' });
        }

        // Проверка допустимых полей
        const validFields = [
            'name',
            'desc',
            'start_date',
            'end_date',
            'ongoing',
            'periodicity',
            'chosen_days',
            'start_time',
            'end_time',
            'pinned',
            'tag'
        ];

        if (!validFields.includes(field)) {
            return res.status(400).json({ error: 'Недопустимое поле для обновления' });
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

            let formattedValue = value;
            if (field === 'start_date' || field === 'end_date') {
                formattedValue = value ? new Date(value).toISOString().split('T')[0] : null;
            }
            const { error } = await supabase
                .from('habits')
                .update({ [field]: formattedValue })
                .eq('id', habit_id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        } catch (err) {
            console.error('Ошибка при обновлении привычки:', err);
            return res.status(500).json({ error: 'Ошибка сервера при обновлении привычки' });
        }
    });
}