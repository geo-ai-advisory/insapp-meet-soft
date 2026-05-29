import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Единая система badge-пиллов для статусов.
 *
 * Variants:
 *   success - зелёный (отправлено, готово)
 *   warning - оранжевый (ждёт, pending)
 *   error   - красный (ошибка)
 *   neutral - серый (неактивно, выключено)
 *   info    - синий (информация)
 *
 * Высота единая: h-7. Иконки stroke-[1.75] для премиум-вида.
 */
const badgePillVariants = cva(
  "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-xs font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]",
  {
    variants: {
      variant: {
        success: "bg-green-50 text-green-700 border-green-200",
        warning: "bg-amber-50 text-amber-700 border-amber-200",
        error: "bg-red-50 text-red-700 border-red-200",
        neutral: "bg-gray-50 text-gray-600 border-gray-200",
        info: "bg-blue-50 text-blue-700 border-blue-200",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export interface BadgePillProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgePillVariants> {}

const BadgePill = React.forwardRef<HTMLSpanElement, BadgePillProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(badgePillVariants({ variant, className }))}
        {...props}
      />
    );
  },
);
BadgePill.displayName = "BadgePill";

export { BadgePill, badgePillVariants };
