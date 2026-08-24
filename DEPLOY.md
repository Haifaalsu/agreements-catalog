# نشر النسخة التجريبية (Staging) — دليل سريع

هذا المشروع تطبيق Node.js/Express + PostgreSQL قياسي، بدون خطوة Build معقدة للواجهة
(الواجهة الأمامية HTML/CSS/JS ثابتة تُقدَّم مباشرة من نفس السيرفر). لا حاجة لخادم Nginx
منفصل أو CDN.

## الطريقة الموصى بها: Render (أو Railway بنفس الخطوات تقريبًا)

هذه أبسط طريقة للحصول على رابط عام يعمل من أي جهاز خلال دقائق:

1. أنشئ حساب على Render.com (يوجد Free/الأرخص كافٍ لتجربة Staging).
2. **Web Service** جديد من هذا المستودع (Repo)، مع:
   - Root Directory: جذر المشروع (فيه `backend/Dockerfile`)
   - Dockerfile Path: `backend/Dockerfile`
3. **PostgreSQL** جديد (مُدار من Render) — انسخ رابط `Internal Database URL`.
4. متغيرات البيئة (Environment) لخدمة الـWeb Service:
   - `DATABASE_URL` = رابط قاعدة البيانات من الخطوة 3
   - `JWT_SECRET` = نص عشوائي طويل وسري
   - `NODE_ENV` = `production`
   - `PORT` يُحدَّده Render تلقائيًا (لا حاجة لتعيينه)
5. بعد أول Deploy ناجح، من تبويب **Shell** الخاص بالخدمة على Render نفّذ مرة واحدة:
   ```
   node dist/scripts/migrate.js
   node dist/scripts/createAdmin.js "اسم المدير" admin@example.com "كلمة مرور قوية"
   node dist/scripts/seedSynonyms.js
   ```
6. افتح رابط الخدمة (`https://xxxxx.onrender.com`) — هذه هي الواجهة العامة للموظفين.
   لوحة الإدارة على `/admin.html` من نفس الرابط.
7. من لوحة الإدارة، استورد ملفات Excel الحقيقية (اتفاقية اتفاقية) كما تم اختباره محليًا.

> ملاحظة: القرص في الخطط المجانية غير دائم — الملفات المرفوعة أثناء الاستيراد (Excel
> الخام) قد لا تبقى بعد إعادة تشغيل الخدمة، لكن هذا **لا يؤثر على البيانات المعتمدة**
> (كل شيء يُخزَّن في PostgreSQL بمجرد اعتماد الدفعة). فقط أعد رفع الملف إذا كنت في
> منتصف عملية استيراد لم تُعتمد بعد وأعيد تشغيل الخدمة.

## بديل: تشغيل محلي فوري بأمر واحد (Docker)

إذا كنت تريد تجربة النسخة الآن على جهازك دون انتظار حساب استضافة:

```bash
docker compose up --build
# في نافذة أخرى، مرة واحدة فقط:
docker compose exec app node dist/scripts/migrate.js
docker compose exec app node dist/scripts/createAdmin.js "اسم المدير" admin@example.com "كلمة مرور قوية"
docker compose exec app node dist/scripts/seedSynonyms.js
```

ثم افتح `http://localhost:4000`. هذا يعمل من نفس الجهاز/الشبكة فقط (ليس "من أي جهاز")
لكنه أسرع طريقة لمعاينة النسخة النهائية فورًا.

## بديل: خادم داخلي تابع للهيئة

إذا كان لدى الهيئة خادم Linux (VM) بالفعل، الخطوات نفسها بدون Docker:

```bash
cd backend && npm install && npm run build
npm run migrate
node dist/scripts/createAdmin.js "اسم المدير" admin@example.com "كلمة مرور قوية"
node dist/scripts/seedSynonyms.js
NODE_ENV=production DATABASE_URL=... JWT_SECRET=... PORT=4000 node dist/server.js
```

يُفضَّل تشغيله خلف Reverse Proxy (Nginx/Caddy) مع HTTPS، ومدير عمليات مثل `pm2` أو
`systemd` لإعادة التشغيل التلقائي.
