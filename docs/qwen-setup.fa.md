# راه‌اندازی دستیار صوتی فارسی با Qwen

این پروژه اکنون از Qwen ابری برای پاسخ متنی، نمونهٔ صدا، تست صوتی مرورگر و مکالمهٔ ربات پشتیبانی می‌کند. کلید سرویس فقط روی سرور نگه داشته می‌شود. برد به سرور صوتی خودت وصل می‌شود و مدل روی ESP32 اجرا نمی‌شود.

## ۱. تنظیمات Qwen

از Alibaba Cloud Model Studio کلید API و Workspace ID همان منطقه را بگیر و دسترسی حساب به مدل را بررسی کن. فایل `.env.example` را به `.env.local` کپی کن و این مقادیر را تکمیل کن:

```dotenv
AI_PROVIDER=qwen
VOICE_PROVIDER=qwen
DASHSCOPE_API_KEY=
DASHSCOPE_WORKSPACE_ID=
DASHSCOPE_REGION=ap-southeast-1
QWEN_TEXT_MODEL=qwen3.8-omni-flash
QWEN_REALTIME_MODEL=qwen3.8-omni-flash-realtime
QWEN_VOICE=Tina
```

`AI_PROVIDER` انتخاب اصلی است و `VOICE_PROVIDER` نام جایگزین آن برای سازگاری است؛ آن‌ها را متناقض تنظیم نکن. منطقهٔ سنگاپور `ap-southeast-1` و پکن `cn-beijing` است. کلید باید متعلق به همان منطقه باشد. نشانی‌های HTTPS و WSS از Workspace ID ساخته می‌شوند؛ اگر کنسول نشانی دیگری ارائه کرد، `QWEN_BASE_URL` و `QWEN_REALTIME_URL` را بدون query در فایل خصوصی وارد کن. صدای ذخیره‌شدهٔ هر شخصیت بر صدای پیش‌فرض اولویت دارد؛ نام‌های اختصاصی OpenAI به صدای پیش‌فرض Qwen برمی‌گردند.

نشانی‌ها و ساختار پیام‌ها بر اساس [راهنمای رسمی Qwen Realtime](https://www.alibabacloud.com/help/en/model-studio/realtime)، [رویدادهای کلاینت](https://www.alibabacloud.com/help/en/model-studio/client-events) و [Qwen Omni](https://www.alibabacloud.com/help/en/model-studio/qwen-omni) پیاده شده‌اند. دسترسی واقعی به مدل و کیفیت فارسی به حساب و صدای انتخابی وابسته است و باید با نمونهٔ صدا بررسی شود.

## ۲. اجرای واقعی پنل

Node.js نسخهٔ 22.13 یا جدیدتر، PostgreSQL و Supabase Auth لازم است. `DATABASE_URL`، `SUPABASE_URL` و `SUPABASE_ANON_KEY` را مطابق [راهنمای نصب](setup.md) تکمیل کن. سپس از ریشهٔ این پروژه:

```powershell
npm ci
npm run migrate
npm run operator -- workspace USER_UUID MyRobots
npm run dev
```

`USER_UUID` را با شناسهٔ واقعی حساب Supabase جایگزین کن. در ترمینال دوم `npm run worker` را اجرا کن. پنل روی `http://127.0.0.1:3100` است. `npm run demo` همچنان فقط دادهٔ آزمایشی دارد و تماس با Qwen را فعال نمی‌کند.

در حالت Qwen، جست‌وجوی دانش خصوصی از متن‌های تأییدشده و نسخه‌بندی‌شده در پایگاه داده و تطبیق واژه‌ها استفاده می‌کند؛ موتور جست‌وجوی معنایی یا embedding نیست و به کلید OpenAI نیاز ندارد. همچنان تأیید، نمایه‌سازی، انتخاب منبع و انتشار لازم است. این قابلیت مهاجرت خودکار مخزن‌های قبلی OpenAI نیست؛ پیش از تغییر سرویس یک نصب موجود، نمایه‌ها و پاک‌سازی فایل‌های سرویس قبلی را تعیین تکلیف کن.

در بخش یکپارچه‌سازی، اعتبار تنظیمات را بررسی کن. تست متن، «نمونهٔ صدا» و تست صوتی Qwen تماس واقعی و احتمالاً هزینه دارند. تست مرورگر به صورت ضبط حداکثر ۱۵ ثانیه، ارسال و پخش پاسخ است؛ هر ضبط یک جلسهٔ مستقل دارد. دسترسی میکروفون در مرورگر به localhost یا HTTPS نیاز دارد.

## ۳. نصب آداپتر در سرور موجود ElatoAI

نسخهٔ سازگار ElatoAI باید شامل `server/deno/main.ts` و `utils.ts` باشد. این دستور ابتدا فایل‌های مقصد را نشان می‌دهد:

```powershell
node scripts/install-companion.mjs "C:\path\to\ElatoAI" --firmware
```

برای نصب همان فایل‌ها و ساخت نسخهٔ پشتیبان محلی:

```powershell
node scripts/install-companion.mjs "C:\path\to\ElatoAI" --firmware --write
```

نصب‌کننده listener موجود را نگه می‌دارد و مسیر `/managed-voice` را اضافه می‌کند. اصلاح‌های محدود سازگاری نوع‌ها برای بررسی بومی Deno نیز اعمال می‌شوند؛ نسخه‌های dependency و lockfile حفظ می‌شوند. اگر ساختار سرور شناخته نشود، نصب انجام نمی‌شود. فایل‌های خصوصی `.env` تغییر نمی‌کنند. کد firmware قابل بازسازی در `companion/firmware-arduino` قرار دارد. نسخهٔ پشتیبان فایل‌های تغییرکرده در `.local/companion-backups` ساخته می‌شود.

تنظیمات `integration/deno/.env.example` را در فایل خصوصی `.env` سرور Deno ادغام کن. کلید Qwen، Workspace ID، منطقه، مدل و `AI_PROVIDER=qwen` باید در آن سرور نیز تنظیم شوند. `MANAGEMENT_BASE_URL` نشانی پنل است و `MANAGEMENT_ADAPTER_SECRET` باید یک مقدار تصادفی یکسان روی پنل و سرور صوتی باشد. این مقدار با bootstrap secret برد فرق دارد.

برای تولید کلید واسط بدون چاپ آن می‌توانی از ابزار مدیریت secret خودت استفاده کنی. اگر آن را در فایل خصوصی می‌نویسی، فایل باید زیر `.local` یا خارج از Git باشد. `VOICE_SERVER_URL` پنل را به `wss://YOUR_VOICE_HOST/managed-voice` تنظیم کن. HTTPS پنل و WSS سرور باید با گواهی معتبر برای برد ارائه شوند. برای اتصال خود سرور صوتی به پنل روی همان لپ‌تاپ، فقط با `MANAGEMENT_ALLOW_LOCAL_HTTP=true` می‌توان از `http://127.0.0.1:3100` استفاده کرد؛ برد همچنان به HTTPS معتبر وصل می‌شود.

در محیط نصب‌شده:

```powershell
deno check management/managed-voice.ts main.ts
deno run -A --env-file=.env main.ts
```

از پورت و روش اجرای فعلی سرور خودت استفاده کن؛ نصب این فایل‌ها سرویس را خودکار راه‌اندازی یا منتشر نمی‌کند.

## ۴. firmware و مدار تو

میکروفون روی GPIOهای `1/4/14`، آمپلی‌فایر روی `6/5/7` و تاچ روی `2` تنظیم شده‌اند. `SD` آمپلی‌فایر به 5V متصل است، پس `ELATO_AMP_SD_PIN=-1` است و سکوت با پاک‌کردن بافر صوتی انجام می‌شود. میکروفون PCM16 مونو 16kHz می‌فرستد. سرور پاسخ PCM24kHz Qwen را به Opus تبدیل می‌کند و برد آن را در 48kHz پخش می‌کند.

نوع دقیق برد باید با تنظیم فعلی Flash شانزده مگابایت و PSRAM از نوع OPI سازگار باشد. قبل از upload، مدل برد و پورت را بررسی کن:

```powershell
cd companion/firmware-arduino
platformio run -e esp32-s3-devkitc-1
platformio run -e esp32-s3-devkitc-1 -t upload --upload-port COM7
```

دستور دوم واقعاً برد را فلش می‌کند؛ پورت نمونه است. در نسخهٔ فعلی TTP223 لحظه‌ای برای بیدارکردن و خواب برد استفاده می‌شود؛ پس از شروع جلسه، تشخیص پایان گفتار روی سرور انجام می‌شود. هنگام پخش، میکروفون به سرویس ارسال نمی‌شود.

OLED روی SDA=8 و SCL=9 رزرو شده است. چون کنترلر و ابعاد آن مشخص نیست، درایور حدس زده نشده و نمایشگر هنوز راه‌اندازی نشده است. جفت‌سازی اولیه بدون OLED از USB انجام می‌شود.

## ۵. Wi-Fi و جفت‌سازی از USB

Serial Monitor با سرعت 115200 و پایان خط LF این دستور را می‌پذیرد:

```text
ELATO_SETUP {"cmd":"wifi","ssid":"YOUR_WIFI","password":"YOUR_PASSWORD"}
```

از `tools/provision_management.py` با Python و `pyserial` برای تنظیمات بعدی استفاده کن؛ هنگام استفاده از ابزار، Serial Monitor را ببند:

```powershell
python tools/provision_management.py status --port COM7
python tools/provision_management.py new-secret --out .local/device-bootstrap.txt
```

MAC گزارش‌شده، MAC ایستگاه Wi-Fi برد است. از ریشهٔ پنل، همان secret را در محیط موقت operator بخوان و هویت برد را ثبت کن:

```powershell
$env:DEVICE_BOOTSTRAP_SECRET = (Get-Content -Raw "PATH_TO_DEVICE_BOOTSTRAP_FILE").Trim()
npm run operator -- provision AA:BB:CC:DD:EE:FF
Remove-Item Env:\DEVICE_BOOTSTRAP_SECRET
```

در پنل، دستگاه جدید را با همان MAC بساز تا درخواست جفت‌سازی ایجاد شود. سپس از پوشهٔ firmware، گواهی ریشهٔ واقعی سرویس‌های HTTPS/WSS و همان فایل secret را روی برد ثبت کن:

```powershell
python tools/provision_management.py provision --port COM7 --origin https://YOUR_PANEL_HOST --voice-host YOUR_VOICE_HOST --ca-file PATH_TO_ROOT_CA_PEM --bootstrap-file .local/device-bootstrap.txt
python tools/provision_management.py pairing --port COM7
```

کد موقت را در پنل وارد کن. اگر `PAIRING_PENDING` دیدی، پس از اتصال Wi-Fi و همگام‌شدن ساعت دوباره درخواست کن. تنظیمات محلی شامل هیچ کلید Qwen نیست. هر برد bootstrap secret مستقل دارد و توکن‌های محدود به دستگاه به صورت خودکار تمدید می‌شوند.

جزئیات فرمان‌ها، محدودیت اندازهٔ گواهی و رفتار تاچ در [راهنمای firmware](qwen-firmware.md) آمده است.

## وضعیت بررسی

تست‌های محلی با سرویس شبیه‌سازی‌شده، صحت اتصال و قالب صدا را بررسی می‌کنند؛ جایگزین تماس واقعی با Qwen یا آزمایش میکروفون و بلندگوی فیزیکی نیستند. هیچ کلید واقعی همراه پروژه منتشر نمی‌شود. نتیجهٔ آزمون‌های این تغییر در [گزارش Qwen](qwen-validation.md) ثبت می‌شود.
