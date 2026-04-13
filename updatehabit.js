import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
    app.get('/updatehabit', (req, res) => {
        res.send("Habit update backend is working");
    });

    app.post('/updatehabit', authenticateUser(supabase), async (req, res) => {
        const { habit_id, table, ...updateData } = req.body;
        const { id: user_id } = req.user;

        if (!user_id) {
            return res.status(401).json({ error: 'User not authenticated' });
        }
        if (!habit_id) {
            return res.status(400).json({ error: 'Habit ID is required' });
        }
        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ error: 'No data provided for update' });
        }

        try {
            const { data: habit, error: habitError } = await supabase
                .from('habits')
                .select('user_id')
                .eq('id', habit_id)
                .single();

            if (habitError || !habit) {
                return res.status(404).json({ error: 'Habit not found' });
            }
            if (habit.user_id !== user_id) {
                return res.status(403).json({ error: 'Access denied to this habit' });
            }

            let validFields = [];
            if (table === 'habits') {
                validFields = [
                    'name', 'desc', 'start_date', 'end_date', 'ongoing',
                    'periodicity', 'chosen_days', 'start_time', 'end_time',
                    'pinned', 'tag'
                ];
            } else if (table === 'habits_settings') {
                validFields = ['metric_type', 'schedule', 'auto_schedule_completion'];
            } else {
                return res.status(400).json({ error: 'Invalid table' });
            }

            for (const field of Object.keys(updateData)) {
                if (!validFields.includes(field)) {
                    return res.status(400).json({ error: `Invalid field: ${field}` });
                }
            }

            let formattedUpdate = { ...updateData };
            if (table === 'habits_settings' && formattedUpdate.schedule === false) {
                formattedUpdate.metric_type = 'timer';
            }

            for (const [field, value] of Object.entries(formattedUpdate)) {
                if (field === 'start_date' || field === 'end_date') {
                    formattedUpdate[field] = value ? new Date(value).toISOString().split('T')[0] : null;
                }
            }

            if (table === 'habits' && 'periodicity' in formattedUpdate && formattedUpdate.periodicity !== 'weekly') {
                formattedUpdate.chosen_days = null;
            }

            let targetId = habit_id;
            if (table === 'habits_settings') {
                const { data: setting, error: settingError } = await supabase
                    .from('habits_settings')
                    .select('id')
                    .eq('habit_id', habit_id)
                    .single();

                if (settingError) {
                    console.error('Error searching for settings:', settingError);
                    return res.status(500).json({ error: 'Server error while searching for settings' });
                }
                if (!setting) {
                    return res.status(404).json({ error: 'Settings not found' });
                }
                targetId = setting.id;
            }

            const { error } = await supabase
                .from(table)
                .update(formattedUpdate)
                .eq('id', targetId);

            if (error) throw error;

            console.log(`✅ Updated: ${Object.keys(formattedUpdate).join(', ')}${formattedUpdate.chosen_days !== undefined ? ' + chosen_days=null' : ''}`);
            return res.status(200).json({ success: true });

        } catch (err) {
            console.error('Error updating habit:', err);
            return res.status(500).json({ error: 'Server error while updating habit' });
        }
    });
}