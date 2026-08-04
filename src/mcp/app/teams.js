/**
 * Human names for the boundaries.
 *
 * The role keys are the contract and never change. They are also unreadable: a product owner
 * looking at a panel should see "تیم کشف و تحقیق", not "RB-03". Engineering boundaries already
 * carry English titles in their catalog; the product ones only had a machine-derived label.
 *
 * `focus` is one short line answering "what does this team actually do", so the panel can explain
 * itself without the reader consulting the governance documents.
 */

const PRODUCT = {
  "RB-01": { name: "هماهنگی و گردش کار", focus: "مسیر رویدادها، وابستگی‌ها و بازکردن کارهای متوقف" },
  "RB-02": { name: "ایده و تصمیم", focus: "ساختاردهی ایده‌ها و آماده‌کردن خلاصهٔ تصمیم برای مالک محصول" },
  "RB-03": { name: "کشف و تحقیق", focus: "پژوهش با منابع قابل ردیابی و بیان صریح عدم‌قطعیت" },
  "RB-04": { name: "تجربه و سفر کاربر", focus: "معنای حوزه‌ها، نقش‌ها، قابلیت‌ها و مسیر کاربر" },
  "RB-05": { name: "مسائل و اولویت", focus: "تبدیل یافته‌ها به مسائل بدون تکرار و با اولویت روشن" },
  "RB-06": { name: "قرارداد تحویل", focus: "ترجمهٔ نیت تأییدشده به تیکت‌های کراندار و قابل آزمون" },
  "RB-07": { name: "طراحی اعتبارسنجی", focus: "سناریوها، داده‌های لازم و نتیجهٔ مورد انتظار" },
  "RB-08": { name: "ریسک و ممیزی منطق", focus: "به‌چالش‌کشیدن فرض‌ها، لبه‌ها و ناسازگاری‌ها" },
  "RB-09": { name: "کیفیت و شواهد", focus: "اجرای سناریوهای تأییدشده و ثبت شواهد بازتولیدپذیر" },
  "RB-10": { name: "یکپارچگی دفترکار", focus: "اعمال نوشتن کنترل‌شده و اثبات بازخوانی کامل" },
  "RB-11": { name: "آمادگی و انتشار", focus: "محاسبهٔ آمادگی و سرهم‌کردن پروندهٔ انتشار" },
  "RB-12": { name: "تأیید مستقل", focus: "بازتولید ادعاهای مهم بدون دست‌زدن به خروجی تولیدکننده" },
  "RB-13": { name: "پل محصول به توسعه", focus: "تحویل قرارداد تأییدشده به مهندسی و بازگرداندن نتیجه" }
};

const ENGINEERING = {
  "ENG-01": { name: "هماهنگی مهندسی", focus: "ترتیب کار و مدیریت وابستگی‌های فنی" },
  "ENG-02": { name: "معماری راه‌حل", focus: "مرزهای سامانه و تصمیم‌های معماری" },
  "ENG-03": { name: "فرانت‌اند و دسترس‌پذیری", focus: "رابط وب، دیزاین‌سیستم و رفتار مرورگر" },
  "ENG-04": { name: "بک‌اند و API", focus: "سرویس‌ها، سازگاری قرارداد و یکپارچه‌سازی" },
  "ENG-05": { name: "اپلیکیشن‌های کلاینت", focus: "موبایل و دسکتاپ، چرخهٔ عمر و رفتار آفلاین" },
  "ENG-06": { name: "پایگاه داده و ذخیره‌سازی", focus: "مدل داده، مهاجرت، پشتیبان و بازیابی" },
  "ENG-07": { name: "داده، تحلیل و هوش مصنوعی", focus: "خط لولهٔ داده، کیفیت مدل و منشأ داده" },
  "ENG-08": { name: "پلتفرم، ابر و شبکه", focus: "زیرساخت، شبکه، ظرفیت و هزینه" },
  "ENG-09": { name: "امنیت و حریم خصوصی", focus: "مدل تهدید، دسترسی و زنجیرهٔ تأمین" },
  "ENG-10": { name: "مهندسی کیفیت", focus: "استراتژی تست خودکار و سنجش پوشش" },
  "ENG-11": { name: "پایداری و کارایی", focus: "اهداف سرویس، رصدپذیری و پاسخ به حادثه" },
  "ENG-12": { name: "تجربهٔ توسعه و تحویل", focus: "بیلد، CI/CD و مکانیک انتشار" },
  "ENG-13": { name: "سئو و کشف‌پذیری وب", focus: "خزش‌پذیری، متادیتا و وب‌وایتالز" },
  "ENG-14": { name: "مستندات فنی", focus: "معماری، رانبوک و دانش پشتیبانی" },
  "ENG-15": { name: "تأیید مستقل مهندسی", focus: "بازتولید ادعاهای مهندسی و صدور حکم" }
};

export const TEAM_DIRECTORY = Object.freeze({ ...PRODUCT, ...ENGINEERING });

export function teamName(roleId) {
  // Risks raised by a pending gate are owned by "human" rather than by a boundary.
  if (roleId === "human") return "مالک محصول";
  return TEAM_DIRECTORY[roleId]?.name ?? roleId;
}

export function describeTeam(roleId, side) {
  const entry = TEAM_DIRECTORY[roleId];
  return {
    id: roleId,
    name: entry?.name ?? roleId,
    focus: entry?.focus ?? "",
    side
  };
}

export const PRODUCT_ROLE_IDS = Object.freeze(Object.keys(PRODUCT));
export const ENGINEERING_ROLE_IDS = Object.freeze(Object.keys(ENGINEERING));
