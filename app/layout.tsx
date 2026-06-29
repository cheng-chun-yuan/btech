import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BTech DKGKit Console",
  description: "Local DKGKit wallet-service MVP for HTSS DKG and threshold approvals.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* Browser extensions (Grammarly, ColorZilla, …) inject attributes onto
          <body> before hydration; suppress that benign top-level attribute diff. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
