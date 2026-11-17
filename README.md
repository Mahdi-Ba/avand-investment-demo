# Avand — gold wallet and trading demo

وب آزمایشی فارسی برای خرید و فروش طلا. تمام قیمت‌ها، پرداخت‌ها و تسویه‌ها ساختگی‌اند.

## اجرا

Docker Desktop را اجرا کنید، سپس:

```sh
docker compose up --build -d
```

وب: http://localhost:3000 — RabbitMQ management: http://localhost:15678 (local demo credentials: `avand` / `avand_local`). سرویس‌ها فقط روی loopback میزبان منتشر می‌شوند. دیتابیس volume پایدار دارد؛ restart موجودی را پاک نمی‌کند.

برای توسعه با Node.js 22:

```sh
npm ci
docker compose up -d db rabbit
npm run migrate
npm start
# در ترمینال دیگر:
npm run worker
```

برای اجرای host از `HOST=127.0.0.1 npm start` استفاده کنید اگر فقط دسترسی محلی می‌خواهید. Docker API داخل container روی 0.0.0.0 است ولی port میزبان روی 127.0.0.1 bind شده است.

## تست

تست‌ها روی دیتابیس جداگانه اجرا می‌شوند و دادهٔ دمو را پاک نمی‌کنند. تنها بار اول:

```sh
docker compose exec db createdb -U avand avand_test
```

سپس:

```sh
npm run typecheck
npm test
```

`TEST_DATABASE_URL` اختیاری است و باید به دیتابیس با نام `avand_test` اشاره کند. هفت سناریوی مالی از PostgreSQL واقعی استفاده می‌کنند؛ تست worker نیز RabbitMQ واقعی می‌خواهد. تست worker صف جدا دارد.

## نمایش دمو

۱. «دریافت قیمت تازه»، سپس خرید با مبلغ پیش‌فرض.
۲. «پرداخت موفق» یا یکی از سناریوهای درگاه را بزنید. worker معمولاً طی چند ثانیه سفارش را کامل می‌کند.
۳. «موفق بدون callback» را با سفارش جدید امتحان کنید؛ job اولیه با inquiry آن را پیدا می‌کند.
۴. برای پرداخت دیررس، پس از ثبت سفارش صبر کنید quote منقضی شود، سپس دکمهٔ دیررس را بزنید؛ وجه به کیف پول برمی‌گردد.
۵. برای فروش ابتدا قیمت تازه بگیرید. مقدار ورودی گرم است، ذخیره‌سازی میکروگرم.
۶. برداشت از ریال قابل استفاده انجام می‌شود؛ شبا checksum معتبر می‌خواهد و پیش‌فرض نمونهٔ آزمایشی است.
۷. از تاریخچه جزئیات سفارش را ببینید؛ پنل پشتیبانی events، entries، jobs و آخرین گزارش تطبیق را دارد. اجرای تطبیق async است.
۸. قطعی provider را در پنل فعال کنید. دریافت قیمت چند بار خطا می‌دهد و مدار باز می‌شود. خاموش‌کردن قطعی مدار باز را فوراً نمی‌بندد؛ پس از cooldown probe انجام می‌شود.

برای سناریوهای ۱۰۰ درخواست و فروش هم‌زمان از تست خودکار استفاده کنید. UI تک‌کاربره است و نمایش دستی این موارد جایگزین تست نیست.

## API خلاصه

- `POST /api/quotes` → قیمت هر گرم ریال، زمان انقضا
- `POST /api/orders` با `Idempotency-Key` و `{kind:"buy",amount:"10000000",quoteId:"..."}`
- فروش: `{kind:"sell",gold:"10000",quoteId:"..."}`؛ gold به میکروگرم
- برداشت: `{kind:"withdraw",amount:"100000",sheba:"IR..."}`
- `POST /api/mock/payments/:id` با `{mode:"success"}`؛ modes: success/failure/duplicate/late/missing/failed_verify
- `POST /api/gateway/callback/:id` فقط اعلان است؛ مبلغ/نتیجه از verify خوانده می‌شود
- `GET /api/balances`، `GET /api/orders`، `GET /api/orders/:id`
- `POST /api/support/reconcile`، `GET /api/support`
- `POST /api/support/jobs/:id/retry` برای dead job

اعداد مالی در API رشتهٔ صحیح هستند. amount ریال است، نه تومان. کارمزد ۱٪ و قیمت ۱۰۰ میلیون ریال/گرم صرفاً فرض دمو است. سیاست انقضا بر اساس زمان پرداخت در ماک است، نه زمان callback.

## مستندات و محدودیت‌ها

- [معماری و طراحی](docs/ARCHITECTURE.md)
- [وضعیت تغییرات](CHANGES.md)

این baseline v1 محلی است. احراز هویت، KYC، مجوزهای اپراتور، بانک واقعی، پشتوانهٔ طلای واقعی، reconciliation بانکی/custodian، refund مستقیم کارت و گواهی امنیت ندارد. زمان‌بندی روزانهٔ تطبیق هنوز دستی است. مدارها به ازای هر فرایند مستقل‌اند. آمادهٔ پول واقعی یا انتشار عمومی نیست.


## بررسی انجام‌شده در این مرحله

- TypeScript typecheck و ۱۵ تست خودکار موفق؛ شامل ۱۰۰ درخواست هم‌زمان، replay پیام RabbitMQ، DLQ و بازیابی.
- اجرای واقعی همهٔ سرویس‌ها با `docker compose up --build -d` موفق.
- smoke از HTTP: خرید با callback تکراری → فروش → برداشت → تطبیق بدون مغایرت؛ جمع ledger برای هر دو دارایی صفر.
- بررسی syntax فایل JS مرورگر موفق؛ بررسی بصری مرورگر به دلیل timeout ابزار انجام نشده است. ویدیوی تحویل هنوز ضبط نشده.

برای تکرار smoke با ایجاد سفارش‌های ساختگی تازه و بدون پاک‌کردن داده‌ها:

```sh
node scripts/smoke.mjs
```
