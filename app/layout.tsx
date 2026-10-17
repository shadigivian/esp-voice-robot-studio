import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: process.env.PRODUCT_NAME || "پنل ربات‌های صوتی",
  description: "مدیریت مستقل نقش، شخصیت و دانش ربات‌های صوتی ESP",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
