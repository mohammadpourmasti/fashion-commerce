import type { ComponentProps, ElementType } from "react";
import { cn } from "@/shared/lib/cn";

/** Page-width container with responsive gutters (16px on phones). */
export function Container({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("mx-auto w-full max-w-page px-4 sm:px-8 lg:px-12", className)} {...props} />
  );
}

/** Thin rule between editorial sections. */
export function Rule({ className, ...props }: ComponentProps<"hr">) {
  return <hr className={cn("border-0 border-t border-line", className)} {...props} />;
}

type HeadingLevel = "display" | "headline" | "title";

const headingStyles: Record<HeadingLevel, string> = {
  display: "font-display text-display font-light tracking-display text-balance",
  headline: "font-display text-headline font-light tracking-display text-balance",
  title: "font-display text-title font-normal",
};

export function Heading({
  as: Tag = "h2",
  level = "headline",
  className,
  ...props
}: ComponentProps<"h2"> & { as?: ElementType; level?: HeadingLevel }) {
  return <Tag className={cn(headingStyles[level], className)} {...props} />;
}

export function Eyebrow({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("eyebrow", className)} {...props} />;
}
