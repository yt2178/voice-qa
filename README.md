# voice-qa — מערכת בקרת איכות לעוזר הקולי (ימות המשיח)

עצמאי לחלוטין: Cloudflare Worker + D1 + אתר סטטי בתוך ה-Worker.

## מה יש כאן
- `worker.js` — API + אתר + פרוקסי הקלטות + סנכרון מימות.
- `schema.sql` — סכימת D1.
- `public/index.html` — הממשק (מוטמע בתוך worker.js).

## הגדרה
1. צור D1: `wrangler d1 create voice-qa` והדבק את ה-id ב-wrangler.toml.
2. הרץ `wrangler d1 execute voice-qa --file=schema.sql --remote`.
3. הגדר סודות: `YEMOT_USERNAME`, `YEMOT_PASSWORD`, `SYNC_KEY`.
4. `wrangler deploy`.
5. ייבוא היסטורי: `curl "https://<worker>/sync?full=1&key=<SYNC_KEY>"`.

## הרשאות
הנתונים נשמרים אצל הבעלים בלבד. אין סיסמאות בקוד. ההקלטות מוזרמות דרך השרת ולא נחשף טוקן.
