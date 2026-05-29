import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Единая дизайн-система кнопок Insapp-meet.
 *
 * Variants (color/intent):
 *   ai          - градиент blue→purple для AI-резюме (hero CTA)
 *   primary     - bg-blue-600 для основных действий (default)
 *   destructive - bg-red-500 для записи/удаления
 *   secondary   - white с border-gray-300 для нейтральных действий
 *   ghost       - transparent для tertiary действий
 *   success     - bg-green-600 для confirm/save
 *   outline     - alias для secondary (совместимость с shadcn)
 *
 * Sizes:
 *   sm      - h-8 (компактные кнопки в panels)
 *   default - h-9 (стандартная высота)
 *   lg      - h-10 (hero)
 *   icon    - h-9 w-9 (квадратная для иконки без текста)
 *
 * Иконки автоматически stroke-[1.75] для премиум-вида.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]",
  {
    variants: {
      variant: {
        ai: "bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-sm hover:from-blue-600 hover:to-purple-600",
        primary: "bg-blue-600 text-white shadow-sm hover:bg-blue-700",
        default: "bg-blue-600 text-white shadow-sm hover:bg-blue-700",
        destructive: "bg-red-500 text-white shadow-sm hover:bg-red-600",
        secondary: "border border-gray-300 bg-white text-gray-900 hover:bg-gray-50",
        outline: "border border-gray-300 bg-white text-gray-900 hover:bg-gray-50",
        ghost: "text-gray-700 hover:bg-gray-100",
        success: "bg-green-600 text-white shadow-sm hover:bg-green-700",
        // Legacy для обратной совместимости со старым кодом
        green: "bg-green-600 text-white hover:bg-green-700",
        blue: "bg-blue-600 text-white hover:bg-blue-700",
        red: "bg-red-500 text-white hover:bg-red-600",
        gray: "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
        link: "text-blue-600 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3 py-2 text-sm",
        sm: "h-8 px-2.5 text-xs",
        lg: "h-10 px-4 text-sm",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
