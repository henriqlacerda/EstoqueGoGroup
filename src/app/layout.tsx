import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EstoqueGoGroup",
  description: "Gestão de estoque simples e organizada.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
