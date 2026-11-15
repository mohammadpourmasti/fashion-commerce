import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/shared/lib/cn";

type Variant = "primary" | "secondary" | "quiet";
type Size = "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-3 font-medium whitespace-nowrap transition-colors duration-300 ease-editorial disabled:pointer-events-none disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary: "bg-charcoal text-ivory hover:bg-charcoal-soft",
  secondary: "border border-charcoal text-charcoal hover:bg-charcoal hover:text-ivory",
  quiet: "link-underline px-0! text-charcoal",
};

const sizes: Record<Size, string> = {
  md: "h-11 px-6 text-sm",
  lg: "h-13 px-8 text-sm",
};

type StyleProps = { variant?: Variant; size?: Size };

export function buttonClasses({ variant = "primary", size = "md" }: StyleProps = {}): string {
  return cn(base, variants[variant], sizes[size]);
}

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & StyleProps) {
  return <button type={type} className={cn(buttonClasses({ variant, size }), className)} {...props} />;
}

export function ButtonLink({
  variant,
  size,
  className,
  ...props
}: ComponentProps<typeof Link> & StyleProps) {
  return <Link className={cn(buttonClasses({ variant, size }), className)} {...props} />;
}
