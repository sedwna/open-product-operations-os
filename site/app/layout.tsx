import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    metadataBase: new URL(origin),
    title: "Open Product Operations OS — Product Control Tower",
    description: "Turn product signals into evidence-backed decisions, delivery, verification, and release.",
    icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
    openGraph: {
      title: "Open Product Operations OS",
      description: "From signal to evidence-backed release",
      images: [{ url: "/og.png", width: 1200, height: 630 }],
      type: "website",
    },
    twitter: { card: "summary_large_image", title: "Open Product Operations OS", description: "From signal to evidence-backed release", images: ["/og.png"] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="fa" dir="rtl"><body>{children}</body></html>;
}
