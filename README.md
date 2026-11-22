# voice-qa — מערכת בקרת איכות לעוזר הקולי (ימות המשיח)

עצמאי לחלוטין: Cloudflare Worker + KV + אתר עברית RTL. ללא Base44, ללא שרת חיצוני.

## כתובת חיה
https://voice-qa.y0508352872.workers.dev

## מה יש כאן
- `worker.js` — API, אתר מוטמע, פרוקסי הקלטות (הטוקן נשאר בשרת), וסנכרון מימות.
- `schema.sql` — סכימה מקבילה ל-D1 (לגיבוי עתידי; כרגע הנתונים ב-KV).
- `public/index.html` — הממשק לפני הטמעה.

## פריסה
```
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT>/workers/scripts/voice-qa" \
  -H "Authorization: Bearer <CF_TOKEN>" \
  -F "metadata=@meta.json;type=application/json" \
  -F "worker.js=@worker.js;type=application/javascript+module"
```
`meta.json` כולל binding בשם `QA_DATA` (KV), `SYNC_KEY`, ו-cron כל 2 דקות.

## סודות
`YEMOT_USERNAME`, `YEMOT_PASSWORD` (secret_text), `SYNC_KEY`.

## ייבוא וסנכרון
- ייבוא חד-פעמי: `POST /import?key=<SYNC_KEY>` עם `{"items":[{"call":{...},"turns":[...],"api_logs":[...]}]}`
- סנכרון מימות: `GET /sync?full=1&key=<SYNC_KEY>` (היסטוריה) או `/sync` (חודשיים אחרונים).

## GitHub Actions
להוספת פריסה אוטומטית צריך טוקן עם הרשאת `workflow`. ה-workflow:
```yaml
name: Deploy voice-qa
on: { push: { branches: [main] }, workflow_dispatch: }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
```
