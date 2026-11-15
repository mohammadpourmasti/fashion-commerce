import { Cormorant_Garamond, Instrument_Sans, Vazirmatn } from "next/font/google";

/**
 * Self-hosted at build time by next/font (no runtime requests to Google).
 * Latin: Cormorant Garamond (display) + Instrument Sans (text).
 * Persian: Vazirmatn for every role — see globals.css `:lang(fa)`.
 */

export const latinDisplay = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  style: ["normal", "italic"],
  variable: "--font-latin-display",
  display: "swap",
});

export const latinSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-latin-sans",
  display: "swap",
});

export const persian = Vazirmatn({
  subsets: ["arabic", "latin"],
  variable: "--font-persian",
  display: "swap",
});

export const fontVariables = [latinDisplay.variable, latinSans.variable, persian.variable].join(
  " ",
);
