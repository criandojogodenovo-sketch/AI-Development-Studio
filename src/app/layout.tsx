import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "AI Development Studio",
    template: "%s | AI Development Studio",
  },
  description:
    "Estúdio de desenvolvimento de software com agentes de IA: planejamento, implementação, testes e revisão automatizados — do pedido à entrega.",
  keywords: [
    "AI Development Studio",
    "agentes de IA",
    "desenvolvimento de software",
    "automação de desenvolvimento",
    "planejamento",
    "revisão de código",
  ],
  authors: [{ name: "AI Development Studio" }],
  applicationName: "AI Development Studio",
  openGraph: {
    title: "AI Development Studio",
    description:
      "Desenvolvimento de software com agentes de IA — do planejamento à entrega.",
    siteName: "AI Development Studio",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "AI Development Studio",
    description:
      "Desenvolvimento de software com agentes de IA — do planejamento à entrega.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
