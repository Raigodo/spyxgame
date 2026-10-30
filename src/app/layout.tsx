import { Geist, Geist_Mono, Roboto_Slab, Public_Sans } from "next/font/google";
import "./globals.css";
import { siteMetadata } from "./site-metadata";
import { PropsWithChildren } from "react";
import { cn } from "cn";
import { Toaster } from "@/ui/components/ui/sonner";

const publicSansHeading = Public_Sans({ subsets: ["latin"], variable: "--font-heading" });

const robotoSlab = Roboto_Slab({ subsets: ["latin"], variable: "--font-serif" });

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = siteMetadata;

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <html
      lang="en"
      className={cn(
        "h-full",
        "antialiased",
        geistSans.variable,
        geistMono.variable,
        "font-serif",
        robotoSlab.variable,
        publicSansHeading.variable
      )}
    >
      <body className="flex flex-col min-h-full">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
