const steps = [
  [
    ".intro",
    "به آزمایشگاه آوند خوش آمدید",
    "در این راهنما هر بخش برنامه را می‌بینید. تمام دارایی‌ها، پرداخت‌ها و سرویس‌ها ساختگی‌اند. راهنما هیچ سفارشی ثبت نمی‌کند و تنظیمات مالی را تغییر نمی‌دهد.",
  ],
  [
    ".balances",
    "موجودی و ارزش دارایی",
    "ریال و طلای این بخش قابل استفاده‌اند؛ مبالغ رزروشده پایین آن جدا نمایش داده می‌شوند. ارزش ریالی طلا تخمینی و وابسته به قیمت فعلی است.",
  ],
  [
    ".market-summary",
    "بازار، سقف و صف",
    "بازار شنبه تا چهارشنبه از ۹ تا ۱۵ تهران باز است. بیرون بازار برای خرید و فروش سقف جدا داریم؛ سفارش مازاد کامل صف می‌شود، دارایی رزرو می‌ماند و تا پیش از اجرا قابل لغو است.",
  ],
  [
    "#topupForm",
    "اول کیف پول را شارژ کنید",
    "مبلغ ریالی را وارد و درخواست شارژ بسازید؛ سپس در بخش درگاه نتیجهٔ پرداخت را انتخاب کنید. بعد از تأیید، وجه بدون کارمزد شارژ قابل خرج می‌شود. شارژ به‌تنهایی طلا نمی‌خرد.",
  ],
  [
    ".quote",
    "قیمت تازه و قفل قیمت",
    "دریافت قیمت تازه، قیمت معامله را برای زمان محدودی قفل می‌کند. شمارش معکوس و تازگی قیمت را ببینید؛ قیمت کهنه یا منقضی برای معاملهٔ فوری پذیرفته نمی‌شود.",
  ],
  [
    "#buyForm",
    "خرید طلا",
    "مبلغ به ریال و شامل کارمزد یک درصد است. پرداخت از کیف پول، موجودی قابل استفاده می‌خواهد؛ خرید مستقیم با درگاه نیز قابل انتخاب است. برای سفارش صف‌شده، قیمت اجرا هنگام بازشدن تعیین می‌شود.",
  ],
  [
    ".scenarios",
    "درگاه آزمایشی و نتیجهٔ سفارش",
    "پس از ساخت شارژ یا خرید درگاهی، می‌توانید پرداخت موفق، ناموفق، callback تکراری یا گمشده و verify ناموفق را امتحان کنید. نتیجه برای سفارش انتخاب‌شده اعمال می‌شود؛ worker تأیید مالی را انجام می‌دهد.",
  ],
  [
    "#orderState",
    "وضعیت، لغو و بازپرداخت",
    "پیام سفارش در اینجا تازه می‌شود. دکمه‌های لغو صف و بازپرداخت یا تأیید مجدد فقط در وضعیت مجاز ظاهر می‌شوند. پرداخت پس از انقضا به کیف پول می‌رود؛ بازپرداخت بانکی مسیر جدا دارد.",
  ],
  [
    "#sellForm",
    "فروش طلا",
    "مقدار را به گرم و حداکثر شش رقم اعشار وارد کنید. قیمت معتبر و طلای قابل استفاده لازم است. پس از فروش، خالص مبلغ با کسر کارمزد وارد کیف پول می‌شود؛ فروش صف‌شده تا اجرا ریال قابل خرج نمی‌سازد.",
  ],
  [
    "#withdrawForm",
    "برداشت به شبا",
    "مبلغ ریالی و شبا را وارد کنید. وجه ابتدا رزرو می‌شود و پس از رسید تسویهٔ بانک ماک نهایی می‌شود. اختلال بانک نباید وجه رزروشده را دوباره قابل خرج کند.",
  ],
  [
    "#history",
    "تاریخچه و انتخاب سفارش",
    "تراکنش‌ها و وضعیتشان را ببینید و با صفحهٔ قبل و بعد مرور کنید. انتخاب سفارش، آن را برای نمایش جزئیات و سناریوهای پرداخت فعال می‌کند.",
  ],
  [
    "#support .support-tools",
    "پشتیبانی و شبیه‌سازی اختلال",
    "تطبیق را در صف قرار دهید یا قطعی قیمت و درگاه را شبیه‌سازی کنید. کنترل‌های بعدی، قطعی بانک و رسید مفقود یا اشتباه خزانه را نشان می‌دهند. این کنترل‌ها تنظیمات مشترک دمو را تغییر می‌دهند؛ پس از آزمایش آن‌ها را برگردانید.",
  ],
  [
    ".mock-market",
    "ساعت بازار و وقفهٔ قیمت",
    "از این پنل می‌توانید ساعت مشترک دمو را تغییر دهید، صف را بررسی کنید و وقفهٔ پانزده‌دقیقه‌ای قیمت بسازید. ساعت دستگاه عوض نمی‌شود. در پایان آزمایش بازگشت به ساعت واقعی را بزنید.",
  ],
  [
    ".support-grid",
    "مدارها، تطبیق و اسناد",
    "وضعیت مدارها و آخرین گزارش تطبیق را ببینید؛ با شناسهٔ سفارش، رویدادها و سندهای آن را بررسی کنید. مغایرت درگاه، بانک و خزانه جدا گزارش می‌شود؛ تغییر مستقیم موجودی راه رفع مغایرت نیست.",
  ],
  [
    'a[href="/demo.html"]',
    "اجرای خودکار هفت سناریو",
    "این لینک صفحهٔ اجرای هفت سناریوی مالی را باز می‌کند. شروع اجرا در آن صفحه سفارش‌های آزمایشی واقعی می‌سازد و نتیجهٔ هر سناریو را نشان می‌دهد. هر زمان خواستید با دکمهٔ راهنمای برنامه، این تور را دوباره ببینید.",
  ],
];
const dialog = document.createElement("dialog");
dialog.className = "tour-dialog";
dialog.setAttribute("aria-labelledby", "tour-title");
dialog.setAttribute("aria-describedby", "tour-text");
dialog.innerHTML = `<div class="tour-highlight" aria-hidden="true"></div><section class="tour-card"><div class="tour-heading"><span id="tour-progress"></span><button type="button" class="secondary" id="tour-close" aria-label="بستن راهنما">بستن ×</button></div><div aria-live="polite" aria-atomic="true"><h2 id="tour-title"></h2><p id="tour-text"></p></div><div class="tour-actions"><button type="button" id="tour-next">بعدی</button><button type="button" class="secondary" id="tour-prev">قبلی</button></div><small>راهنما فقط توضیح می‌دهد · برای خروج کلید Escape را بزنید.</small></section>`;
document.body.append(dialog);
let index = 0,
  target = null,
  openedDetails = null;
const el = (id) => dialog.querySelector(`#${id}`);
function position() {
  if (!dialog.open || !target) return;
  const r = target.getBoundingClientRect();
  Object.assign(dialog.querySelector(".tour-highlight").style, {
    top: `${Math.max(2, r.top - 5)}px`,
    left: `${Math.max(2, r.left - 5)}px`,
    width: `${Math.min(r.width + 10, innerWidth - 4)}px`,
    height: `${Math.min(r.height + 10, innerHeight - Math.max(2, r.top - 5) - 2)}px`,
  });
}
function restoreDetails() {
  if (openedDetails) {
    openedDetails.open = false;
    openedDetails = null;
  }
}
function render() {
  restoreDetails();
  const [selector, title, text] = steps[index];
  target = document.querySelector(selector);
  const details = target?.closest("details");
  if (details && !details.open) {
    details.open = true;
    openedDetails = details;
  }
  el("tour-title").textContent = title;
  el("tour-text").textContent = text;
  el("tour-progress").textContent =
    `مرحلهٔ ${(index + 1).toLocaleString("fa-IR")} از ${steps.length.toLocaleString("fa-IR")}`;
  el("tour-prev").disabled = index === 0;
  el("tour-next").textContent =
    index === steps.length - 1 ? "پایان راهنما" : "بعدی";
  target?.scrollIntoView({ behavior: "instant", block: "start" });
  position();
}
function move(delta) {
  index = Math.max(0, index + delta);
  if (index >= steps.length) dialog.close();
  else render();
}
document.getElementById("startTour").addEventListener("click", () => {
  index = 0;
  dialog.showModal();
  render();
  el("tour-next").focus();
});
el("tour-next").addEventListener("click", () => move(1));
el("tour-prev").addEventListener("click", () => move(-1));
el("tour-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  restoreDetails();
  target = null;
  document.getElementById("startTour").focus({ preventScroll: true });
});
dialog.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    move(event.key === "ArrowLeft" ? 1 : -1);
  }
});
window.addEventListener("resize", position);
window.addEventListener("scroll", position, { passive: true });
