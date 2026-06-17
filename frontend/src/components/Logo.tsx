import React from "react";
import Image from "next/image";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog";
import { VisuallyHidden } from "./ui/visually-hidden";
import { About } from "./About";

interface LogoProps {
    isCollapsed: boolean;
}

const Logo = React.forwardRef<HTMLButtonElement, LogoProps>(({ isCollapsed }, ref) => {
  return (
    <Dialog aria-describedby={undefined}>
      {isCollapsed ? (
        <DialogTrigger asChild>
          <button
            ref={ref}
            className="flex items-center justify-center cursor-pointer bg-transparent border-none p-0 hover:opacity-80 transition-opacity"
            title="Insapp-meet"
          >
            <Image src="/icon_128x128.png" alt="Insapp-meet" width={36} height={36} />
          </button>
        </DialogTrigger>
      ) : (
        <DialogTrigger asChild>
          <button
            ref={ref}
            className="w-full flex items-center gap-2 mb-3 cursor-pointer bg-transparent border-none p-0 hover:opacity-80 transition-opacity"
            title="О приложении"
          >
            <span className="inline-flex items-baseline font-bold tracking-[-0.02em] text-[18px] leading-none">
              <span className="text-[hsl(var(--brand-blue))]">IN</span>
              <span className="text-[hsl(var(--foreground))]">meet</span>
              <span className="w-1 h-1 rounded-full bg-[hsl(var(--brand-red))] self-end mb-[3px] ml-px" />
            </span>
          </button>
        </DialogTrigger>
      )}
      <DialogContent>
        <VisuallyHidden>
          <DialogTitle>О приложении Insapp-meet</DialogTitle>
        </VisuallyHidden>
        <About />
      </DialogContent>
    </Dialog>
  );
});

Logo.displayName = "Logo";

export default Logo;
