# اتصال دستیار فارسی به Groq و Qwen

کلید ساخته‌شده در Groq در متغیر `GROQ_API_KEY` استفاده می‌شود. مدل پیش‌فرض مکالمه در این مسیر `qwen/qwen3.8-27b` است. این مدل در [فهرست رسمی Groq](https://console.groq.com/docs/model/qwen/qwen3.8-27b) به‌صورت Preview ارائه می‌شود؛ دسترسی حساب باید با تست اتصال بررسی شود.

مسیر صدا این است: میکروفون ← Whisper روی Groq ← متن فارسی ← Qwen روی Groq ← پل صدای فارسی ← بلندگو. پل این نصب از Piper محلی با صدای `fa_IR-amir-medium` استفاده می‌کند. Groq کلید DashScope و Workspace ID نمی‌خواهد. مدل Qwen این مسیر خروجی متن دارد؛ پل صدا باید جداگانه اجرا شود.

## تنظیمات خصوصی سرور

در `.env.local` پنل و فایل `.env` سرور Deno مقادیر زیر را تنظیم کن. فایل‌های واقعی تنظیمات در Git نادیده گرفته می‌شوند. مقادیر کلیدها باید فقط روی سرور باشند.

```dotenv
AI_PROVIDER=groq
VOICE_PROVIDER=groq
GROQ_API_KEY=
GROQ_TEXT_MODEL=qwen/qwen3.8-27b
GROQ_STT_MODEL=whisper-large-v3-turbo
GROQ_LANGUAGE=fa
GROQ_TTS_URL=http://127.0.0.1:8765/speech
SPEECH_BRIDGE_TOKEN=
GROQ_TTS_VOICE=fa_IR-amir-medium
```

`AI_PROVIDER` انتخاب اصلی است؛ `VOICE_PROVIDER` نام جایگزین برای سازگاری است. کلید Groq را در `DASHSCOPE_API_KEY` یا `OPENAI_API_KEY` نگذار. برای برگشت به اتصال‌های قبلی می‌توان `AI_PROVIDER=qwen` یا `AI_PROVIDER=openai` را همراه تنظیمات همان سرویس انتخاب کرد.

پل صدا با توکن داخلی `SPEECH_BRIDGE_TOKEN` احراز هویت می‌کند و در پاسخ `POST /speech`، صدای PCM16 مونو با نرخ 24kHz برمی‌گرداند. قرارداد پاسخ `Content-Type: audio/pcm` و `X-Audio-Sample-Rate: 24000` است. مقدار `GROQ_TTS_VOICE` باید با صدای نصب‌شده در پل هماهنگ باشد.

## نصب و اجرای پل فارسی در ویندوز

دستورهای PowerShell زیر را از ریشهٔ همین پروژه، کنار `package.json`، اجرا کن. Python 3.11 نسخهٔ ۶۴ بیتی لازم است. محیط Python، مدل و نمونه‌های صوتی زیر `.local` نگه‌داری می‌شوند و وارد Git نمی‌شوند؛ Python سراسری تغییر نمی‌کند.

```powershell
py -3.11 -m venv .local/piper-runtime
& ./.local/piper-runtime/Scripts/python.exe -m pip install -r scripts/speech-requirements.txt
& ./.local/piper-runtime/Scripts/python.exe -m piper.download_voices --data-dir .local/piper-voices fa_IR-amir-medium
```

اگر فرمان `py` روی این لپ‌تاپ موجود نبود، می‌توان فقط دستور ساخت محیط را با Python موجود PlatformIO اجرا کرد:

```powershell
& 'C:/Users/shadi/.platformio/penv/Scripts/python.exe' -m venv .local/piper-runtime
```

دریافت خودکار صدا از مخزن رسمی Piper Voices انجام می‌شود. برای دریافت دستی، هر دو فایل [مدل ONNX](https://huggingface.co/rhasspy/piper-voices/resolve/main/fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx) و [پیکربندی JSON](https://huggingface.co/rhasspy/piper-voices/resolve/main/fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx.json) باید با نام اصلی در `.local/piper-voices` قرار بگیرند. [کارت مدل](https://huggingface.co/rhasspy/piper-voices/blob/main/fa/fa_IR/amir/medium/MODEL_CARD) را نیز برای اطلاعات مجوز نگه دار. حجم مدل حدود ۶۴ مگابایت است. Piper یک وابستگی جداگانه با مجوز [GPL-3.0-or-later](https://pypi.org/project/piper-tts/) است؛ کارت این صدا مجوز دیتاست را CC0 اعلام می‌کند. هنگام توزیع موتور یا مدل، شرایط همان مجوزها را همراه آن‌ها رعایت کن.

`SPEECH_BRIDGE_TOKEN` باید در `.env.local` مقدار خصوصی و تصادفی با حداقل ۱۶ نویسه و بدون فاصله داشته باشد. پنل، سرور Deno و پل باید از مقدار یکسان استفاده کنند. آن را در firmware، مرورگر یا مخزن قرار نده. سپس پل را در یک پنجرهٔ جدا اجرا کن:

```powershell
& ./.local/piper-runtime/Scripts/python.exe scripts/speech_bridge.py --env-file .env.local --model .local/piper-voices/fa_IR-amir-medium.onnx
```

این فرایند باید هنگام استفاده از دستیار باز بماند؛ `Ctrl+C` آن را متوقف می‌کند. پل مدل را یک‌بار بارگذاری می‌کند و صدای اصلی 22050Hz را به PCM16 در 24000Hz تبدیل می‌کند. برای بررسی آماده بودن، در PowerShell دیگری اجرا کن:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

پاسخ شامل `ready: true` و `voice: fa_IR-amir-medium` است. مسیر سلامت به کلید نیاز ندارد؛ مسیر `/speech` هدر `Authorization: Bearer ...` می‌خواهد. پل فقط روی `127.0.0.1:8765` گوش می‌دهد و درخواست دارای هدر مرورگر `Origin` را رد می‌کند. فراخوانی صوتی باید از فرایند سرور روی همان ماشین انجام شود. `127.0.0.1` از داخل کانتینر یا ماشین دیگر به همان محیط اشاره می‌کند؛ برای اجرای پنل و Deno روی میزبان‌های جدا، پل محلی هر میزبان را جدا اجرا کن. ESP32 به سرور صوتی متصل می‌شود و مستقیم به این پل وصل نمی‌شود.

آزمون‌های پل بدون حساب ابری و با صدای ساختگی اجرا می‌شوند:

```powershell
& ./.local/piper-runtime/Scripts/python.exe scripts/test_speech_bridge.py
```

هفت آزمون، احراز هویت، رد درخواست مرورگر، محدودیت متن و بدنه، نرخ و قالب صدا، پاسخ سریع `429` هنگام مشغول بودن، سلامت و سقف خروجی را بررسی می‌کنند. هر درخواست حداکثر ۳۰۰۰ نویسه متن و ۳۲ کیلوبایت بدنه دارد؛ خروجی حداکثر ۲ مگابایت است و دریافت بدنه مهلت کلی ۵ ثانیه دارد. فقط یک تولید صدا هم‌زمان انجام می‌شود.

در بررسی همین نصب، تولید واقعی یک جملهٔ فارسی از مسیر HTTP محلی موفق بود: پاسخ `200`، PCM16 مونو در 24000Hz و 118144 بایت خروجی. نمونهٔ بررسی در `.local/piper-bridge-smoke.wav` ذخیره شد. این آزمون، پل محلی را تأیید می‌کند؛ دسترسی زندهٔ Groq هنوز به‌دلیل پاسخ `403 Forbidden` تأیید نشده است.

## اجرای پنل و آزمایش

تنظیمات PostgreSQL، Supabase Auth، سرور صوتی و جفت‌سازی دستگاه طبق [راهنمای نصب](setup.md) و [راهنمای مدار و firmware](qwen-setup.fa.md) همچنان لازم‌اند. پس از تغییر فایل محیط، فرایند پنل و سرور صوتی را دوباره اجرا کن.

ابتدا از صفحهٔ یکپارچه‌سازی «آزمایش اتصال» را اجرا کن. این تست فقط معتبر بودن کلید و قابل‌مشاهده بودن مدل متن را بررسی می‌کند. سپس تست متن را با یک سؤال فارسی، نمونهٔ صدا و ضبط کوتاه مرورگر را امتحان کن. فعال بودن کارت Groq به معنی آماده بودن خروجی صوتی نیست؛ کارت صدای فارسی تنظیمات پل را جداگانه نشان می‌دهد. `npm run demo` از داده‌های ساختگی استفاده می‌کند و تماس واقعی با سرویس ندارد.

در حالت Groq، دانش دستگاه همان جست‌وجوی واژه‌ای محلی از منابع تأییدشده است؛ فایل‌ها برای نمایه‌سازی به OpenAI فرستاده نمی‌شوند. ابزارهای مدل از طریق جلسهٔ احراز هویت‌شده و تنظیمات همان دستگاه اجرا می‌شوند.

## صدا و برد

تبدیل گفتار از مسیر [رسمی transcriptions](https://console.groq.com/docs/speech-to-text) و زبان `fa` انجام می‌شود تا گفتار فارسی به انگلیسی ترجمه نشود. میکروفون برد PCM16 مونو 16kHz می‌فرستد؛ خروجی پل با نرخ 24kHz به Opus تبدیل می‌شود و ESP32 طبق تنظیمات فعلی با نرخ 48kHz آن را پخش می‌کند. سیم‌کشی GPIOها برای تغییر سرویس هوش مصنوعی نیاز به تغییر ندارد.

در تست‌های خودکار از کلید ساختگی و پاسخ‌های HTTP محلی استفاده می‌شود. در بررسی زندهٔ این نصب، درخواست‌های فهرست مدل‌ها و مکالمه به Groq با پاسخ `HTTP 403 Forbidden` روبه‌رو شدند؛ بنابراین دسترسی حساب به مدل و مکالمهٔ واقعی تأیید نشده است. این وضعیت ممکن است به دسترسی حساب یا محدودیت شبکه مربوط باشد و پیش از استفادهٔ واقعی باید برطرف شود. کیفیت تشخیص و پخش روی مدار نیز باید جداگانه بررسی شود.
