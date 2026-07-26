import type { Metadata, Viewport } from "next";
import "./globals.css";

const supabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
  : null;

export const metadata: Metadata = {
  title: {
    default: "SNP Camps · Medical Camp Desk",
    template: "%s · SNP Camps",
  },
  description:
    "Medical camp desk: register, print prescription (queue), staff-scan doctor assign — Sikar Nagarik Parishad (Kolkata)",
  applicationName: "SNP Camps",
  formatDetection: { telephone: false },
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "https://snp-camps.vercel.app",
  ),
  openGraph: {
    type: "website",
    title: "SNP Camps · Medical Camp Desk",
    description: "Register, queue and get seen at the SNP eye camp.",
    siteName: "SNP Camps",
  },
  robots: { index: false, follow: false },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "SNP Camps",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a5c3a",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" data-scroll-behavior="smooth">
      <head>
        {supabaseOrigin ? (
          <link
            rel="preconnect"
            href={supabaseOrigin}
            crossOrigin="anonymous"
          />
        ) : null}
      </head>
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
