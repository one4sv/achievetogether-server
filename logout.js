export default function (app) {
  app.get('/logout', (req, res) => {
    res.clearCookie('token', {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
    });

    res.status(200).json({ success: true, message: "Вы вышли из системы" });
  });
}
