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
            <Image src="/icon_128x128.png" alt="Insapp-meet" width={28} height={28} className="flex-shrink-0" />
            <span className="text-base font-semibold text-gray-900">Insapp-meet</span>
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
