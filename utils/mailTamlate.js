export const getMailTemplate = ({
    code,
    title,
    subtitle,
    expireText = "Код действителен 15 минут"
}) => `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
</head>
<body style="
    margin:0;
    padding:40px 20px;
    background:#121212;
    font-family:Arial,sans-serif;
">
    <div style="
        max-width:600px;
        margin:auto;
        background:#1d1d1d;
        border:1px solid #a1a1a1;
        border-radius:16px;
        overflow:hidden;
    ">
        <div style="
            padding:32px;
            text-align:center;
        ">
            <h1 style="
                margin:0 0 24px;
                color:white;
                font-size:36px;
            ">
                Achieve Together
            </h1>

            <p style="
                color:#d0d0d0;
                font-size:16px;
                margin-bottom:32px;
            ">
                ${title}
            </p>

            <p style="
                color:#a1a1a1;
                margin-bottom:20px;
            ">
                ${subtitle}
            </p>

            <div style="
                background:#141414;
                border:1px solid #14b314;
                border-radius:12px;
                padding:20px;
                margin-bottom:24px;
            ">
                <div style="
                    color:#14b314;
                    font-size:40px;
                    font-weight:700;
                    letter-spacing:8px;
                ">
                    ${code}
                </div>
            </div>

            <p style="
                color:#a1a1a1;
                margin:0;
                font-size:14px;
            ">
                ${expireText}
            </p>
        </div>

        <div style="
            border-top:1px solid #333;
            padding:20px;
            text-align:center;
            color:#888;
            font-size:13px;
        ">
            Если это были не вы — проигнорируйте письмо.
        </div>
    </div>
</body>
</html>
`;