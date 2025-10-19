import { authenticateUser } from "./middleware/token.js"

export default function (app, supabase) {
    app.post('/updatesettings', authenticateUser(supabase), async (req, res) => {
        const setting = Object.keys(req.body)[0];
        const value = req.body[setting];

        const { id } = req.user;
        if (!id) return res.status(401).json({ error: 'User not authenticated' });

        try {
            if (['order', 'amountHabits', 'theme', 'private', 'acsent', 'bg', 'decor', 'note', 'mess_note'].includes(setting)) {
                const { error } = await supabase
                    .from('settings')
                    .upsert({
                        user_id: id,
                        [setting]: value,
                    }, { onConflict: ['user_id'] });
                if (error) throw error;

                return res.status(200).json({ success: true });
            } else {
                return res.status(400).json({ error: 'Invalid setting type' });
            }
        } catch (err) {
            console.error('Ошибка при обновлении:', err);
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    });
}
