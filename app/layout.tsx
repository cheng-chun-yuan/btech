import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Savara DKGKit Console",
  description: "Local DKGKit wallet-service MVP for HTSS DKG and threshold approvals.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Browser extensions (Immersive Translate, Grammarly, ColorZilla, …) inject
  // attributes onto <html> and <body> before hydration; suppressHydrationWarning
  // on both elements silences those benign top-level attribute diffs.
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
